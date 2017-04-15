// Messages in kafka will be encoded using msgpack.
const msgpack = require('msgpack-lite')
const assert = require('assert')
const kafka = require('kafka-node')

const kclient = new kafka.Client()

const randInt = max => (Math.random() * max) | 0

const setRaw = (x, y, index) => {
}


// Each edit is 3 bytes (10 bits x, 10 bits y, 4 bits for color).
const encodeEditTo = (buffer, offset, x, y, color) => {
  // Writes in buffer[offset], buffer[offset+1] and buffer[offset+2].
  assert(x >= 0 && x < 1000 && y >= 0 && y < 1000 & color >= 0 && color < 16)

  // Encoding:
  // byte 1 is just the lower 8 bits of x
  // byte 2 is the upper 2 bits of x and the lower 6 bits of y
  // byte 3 is the upper 4 bits of y then the color.
  buffer[offset] = x & 0xff
  buffer[offset + 1] = (x >>> 8) | ((y & 0x3f) << 2)
  buffer[offset + 2] = ((y & 0x3c0) >> 6) | color << 4
}

const kproducer = new kafka.Producer(kclient)

// An aggregator is basically a reduce function thats called over time. It will
// call the dispatch function at most once per timeout period, and messages
// sent to the aggregator will be delayed by no more than the timeout.
function makeAggregator(timeout, aggregate, dispatch) {
  let pending = false

  return (...args) => {
    aggregate(...args)

    if (!pending) {
      pending = true
      setTimeout(() => {
        pending = false
        dispatch()
      }, timeout)
    }
  }
}

// This is a buffer of the incoming writes.
const processEdit = (() => {
  const buffer = new Buffer(1000 * 100 * 3) // 100k edits per 200ms. Proooobably fine.
  let pos = 0
  let callbacks = []

  // Hold messages for up to 200ms. Maximum roundtrip time will be this delay +
  // equivalent delay for sending.
  const ag = makeAggregator(200, (x, y, c) => {
    encodeEditTo(buffer, pos, x, y, c)
    pos += 3
  }, () => {
    const cbs = callbacks
    callbacks = []

    process.stdout.write('.')
    kproducer.send([{
      topic: 'sephsplace',
      // message type 0, x, y, color.
      messages: [msgpack.encode([1, buffer.slice(0, pos), Date.now()])],
    }], err => {
      if (err) console.error('error publishing to producer', err)
      for (let i = 0; i < cbs.length; i++) cbs[i](err)
    })

    pos = 0
  })

  return (x, y, c, callback) => {
    if (callback) callbacks.push(callback)
    ag(x, y, c)
  }
})()


setInterval(() => {
  processEdit(randInt(10), randInt(10), randInt(16))
  processEdit(randInt(10), randInt(10), randInt(16))
  processEdit(randInt(10), randInt(10), randInt(16))
  processEdit(randInt(10), randInt(10), randInt(16))
}, 10)

kproducer.once('ready', () => {
  console.log('Adding load...')
})

