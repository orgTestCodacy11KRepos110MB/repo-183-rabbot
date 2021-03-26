require('../setup.js')
const connectionFn = require('../../src/connectionFsm.js')
const noOp = function () {}
const EventEmitter = require('events')

function closer () {
  this.raise('released')
}

const connectionMonadFn = function () {
  let handlers = {}

  function raise (ev) {
    if (handlers[ev]) {
      handlers[ev].apply(undefined, Array.prototype.slice.call(arguments, 1))
    }
  }

  function on (ev, handle) {
    handlers[ev] = handle
  }

  function reset () {
    handlers = {}
    this.createChannel = noOp
    this.createConfirmChannel = noOp
    this.release = noOp
  }

  const instance = {
    acquire: function () {
      this.raise('acquiring')
      return Promise.resolve()
    },
    item: { uri: '' },
    close: closer,
    createChannel: noOp,
    createConfirmChannel: noOp,
    on: on,
    emit: this.raise,
    raise: raise,
    release: noOp,
    reset: reset
  }
  instance.close.bind(instance)
  setTimeout(instance.acquire.bind(instance), 0)
  return instance
}

describe('Connection FSM', function () {
  describe('when configuration has getter', function () {
    let connection
    it('should not throw exception', function () {
      expect(function () {
        connection = connectionFn({
          get: function (property) {
            const value = this[property]
            if (value === undefined) {
              throw new Error('Configuration property "' + property + '" is not defined')
            }
            return value
          }
        })
      }).to.not.throw(Error)
    })

    after(function () {
      connection.close()
    })
  })

  describe('when connection is unavailable (failed)', function () {
    describe('when connecting', function () {
      let connection, monad
      before(function (done) {
        monad = connectionMonadFn()
        connection = connectionFn({ name: 'failure', failAfter: .05 }, function () {
          return monad
        })
        monad.release = function () {
          return Promise.resolve()
        }
        connection.once('connecting', function () {
          monad.raise('failed', new Error('bummer'))
        })
        connection.once('failed', function () {
          done()
        })
      })

      it('should transition to failed status', function () {
        connection.currentState.should.equal('failed')
      })

      describe('implicitly (due to operation)', function () {
        let error
        before(function (done) {
          monad.createChannel = function () {
            return Promise.reject(new Error(':( no can do'))
          }
          connection.once('connecting', function () {
            monad.raise('failed', new Error('connection failed'))
          })
          connection.once('failed', function (err, msg) {
            error = msg
            done()
          })
          connection.getChannel()
          monad.raise('acquiring')
        })

        it('should fail to create channel', function () {
          error.toString().should.contain('connection failed')
        })

        it('should transition to failed status', function () {
          connection.currentState.should.equal('failed')
        })
      })

      describe('explicitly', function () {
        before(function (done) {
          connection.once('failed', function () {
            done()
          })
          connection.once('connecting', function () {
            monad.raise('failed', new Error('bummer'))
          })
          connection.connect()
        })

        it('should transition to failed status', function () {
          connection.currentState.should.equal('failed')
        })
      })

      after(function() {
        connection.removeAllListeners()
      })
    })
  })

  describe('when connection is available', function () {
    describe('when first node fails', function () {
      let connection, monad, badEvent, onAcquiring
      before(function (done) {
        // this nightmare of a test setup causes the FSM to get a failed
        // event from the connection monad.
        // on the failed event, connect is called which triggers an 'acquiring'
        // event and transitions the FSM to 'connecting state'.
        // on the acquiring event, we raise the 'acquired' event from the monad
        // causing the FSM to transition into a connected state and emit 'connected'
        // but it should NOT emit 'reconnected' despite failures since an original connection
        // was never established
        const attempts = ['acquired', 'failed']
        monad = connectionMonadFn()
        connection = connectionFn({ name: 'success' }, function () {
          return monad
        })
        connection.once('connected', function () {
          onAcquiring.off()
          done()
        })
        connection.once('reconnected', function () {
          badEvent = true
        })
        connection.once('failed', function () {
          process.nextTick(function () {
            connection.connect()
          })
        })
        onAcquiring = connection.on('connecting', function () {
          const ev = attempts.pop()
          process.nextTick(function () {
            monad.raise(ev)
          })
        })
      })

      it('should transition to connected status', function () {
        connection.currentState.should.equal('connected')
      })

      it('should not emit reconnected', function () {
        should.not.exist(badEvent)
      })
    })

    describe('when connecting (with failed initial attempt)', function () {
      let connection, monad, badEvent, onAcquiring, channel
      before(function () {
        // this nightmare of a test setup causes the FSM to get a failed
        // event from the connection monad.
        // on the failed event, connect is called which triggers a 'connecting'
        // event and transitions the FSM to 'connecting state'.
        // on the acquiring event, we raise the 'acquired' event from the monad
        // causing the FSM to transition into a connected state and emit 'connected'
        // but it should NOT emit 'reconnected' despite failures since an original connection
        // was never established
        const attempts = ['acquired', 'failed']
        monad = connectionMonadFn()
        connection = connectionFn({ name: 'success' }, function () {
          return monad
        })
        connection.once('connected', function () {
          onAcquiring.off()
        })
        connection.once('reconnected', function () {
          badEvent = true
        })
        connection.once('failed', function () {
          process.nextTick(function () {
            connection.connect()
          })
        })
        onAcquiring = connection.on('connecting', function () {
          const ev = attempts.pop()
          setTimeout(() => {
            monad.raise(ev)
          }, 10)
        })
        return connection.after('connected').then(() => onAcquiring.off())
      })

      it('should transition to connected status', function () {
        connection.currentState.should.equal('connected')
      })

      it('should not emit reconnected', function () {
        should.not.exist(badEvent)
      })

      describe('when acquiring a channel', function () {
        const emitter = new EventEmitter()
        before(function () {
          monad.createChannel = function () {
            return Promise.resolve(emitter)
          }
        })

        it('should create channel', function () {
          const result = connection.getChannel('test', false, 'testing channel creation')
            .then(function (x) {
              channel = x
            })
            .catch(e => console.log(e))
          setTimeout(() => emitter.emit('acquired'), 10)
          return result
        })

        after(function () {
          return channel.release()
        })
      })

      describe('when closing with queues', function () {
        let queueMock
        const queue = { release: noOp }
        before(function () {
          queueMock = sinon.mock(queue)
          queueMock.expects('release').exactly(5).returns(Promise.resolve(true))
          connection.addQueue(queue)
          connection.addQueue(queue)
          connection.addQueue(queue)
          connection.addQueue(queue)
          connection.addQueue(queue)

          monad.close = function () {
            // prevents the promise from being returned if the queues haven't all resolved
            queueMock.verify()
            monad.raise('released')
            return Promise.resolve(true)
          }

          return connection
            .close()
        })

        it('should have destroyed all queues before closing', function () {
          queueMock.verify()
        })

        after(function () {
          monad.close = closer.bind(monad)
        })
      })

      describe('when closing with queues after lost connection', function () {
        let queueMock
        const queue = { release: noOp }
        before(function () {
          queueMock = sinon.mock(queue)
          queueMock.expects('release').never()
          connection.addQueue(queue)
          connection.addQueue(queue)
          connection.addQueue(queue)
          connection.addQueue(queue)
          connection.addQueue(queue)

          monad.raise('released')

          return connection
            .close()
        })

        it('should not attempt to release queues', function () {
          queueMock.verify()
        })

        it('should be in closed state', function () {
          connection.currentState.should.eql('closed')
        })
      })

      describe('when connection is lost', function () {
        let onAcquired
        before(function () {
          onAcquired = connection.on('connecting', function () {
            monad.raise('acquired')
          })
          setTimeout(function () {
            channel.emit('acquired')
          }, 500)
          return connection.connect()
            .then(function () {
              connection.addQueue({})
              connection.addQueue({})
              connection.addQueue({})
            }, console.log)
        })

        it('it should emit reconnected after a loss', function (done) {
          connection.once('reconnected', function () {
            done()
          })
          monad.raise('closed')
        })

        after(function () {
          onAcquired.off()
          return connection.close()
        })
      })
    })
  })
})
