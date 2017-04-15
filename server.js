// Alright.
//
// So this will have 3 APIs:
//
// - Write API - POST JSON edits to /edit or something
// - Fetch image API - this will only be hit by nginx. It returns the current place image and its version
// - Event stream API - This is a server-sent event stream which will just forward events from kafka.


// lmdb will be used to store the local image cache.
const lmdb = require('node-lmdb')

// Messages in kafka will be encoded using msgpack.
const msgpack = require('msgpack-lite')
const assert = require('assert')
const PNG = require('pngjs').PNG
const kafka = require('kafka-node')
const fresh = require('fresh')
const url = require('url')
const WSS = require('ws').Server;
const express = require('express')


const kclient = new kafka.Client()
const app = express()
const server = require('http').createServer(app)
const wss = new WSS({server, perfMessageDeflate: false})

app.use('/sp', express.static(__dirname + '/public'))

// This is important so we can hot-resume when the server starts without
// needing to read the entire kafka log. A file would almost be good enough,
// but we need to atomically write to it. So, this is easier.
const dbenv = new lmdb.Env()

const fs = require('fs')
if (!fs.existsSync('snapshot')) fs.mkdirSync('snapshot')
dbenv.open({ path: 'snapshot', mapSize: 100*1024*1024 })
const snapshotdb = dbenv.openDbi({create: true})


const randInt = max => (Math.random() * max) | 0

const loadSnapshot = () => {
  // Read a snapshot from the database if we can.
  const txn = dbenv.beginTxn({readOnly: true})

  const _version = txn.getNumber(snapshotdb, 'version')
  if (_version != null) {
    const data = txn.getBinary(snapshotdb, 'current')
    assert(data)

    console.log('loaded snapshot at version', _version)
    return [data, _version]
  } else {
    console.log('snapshot database empty. Replaying entire log')
    // Technically I only need half this much space - its only 4 bit color after all.
    const data = new Buffer(1000 * 1000)
    data.fill(0)
    return [data, -1]
  }

  txn.commit()
}

let [imgData, version] = loadSnapshot()

const palette = [
  [255, 255, 255], // white
  [228, 228, 228], // light grey
  [136, 136, 136], // grey
  [34, 34, 34], //black

  [255,167,209], // pink
  [229, 0, 9], // red
  [229, 149, 0], // orange

  [160, 106, 66], // brown

  [229, 217, 0], // yellow
  [148, 224, 68], // light green
  [2, 190, 1], // green
  [0, 211, 221], // cyan

  [0, 131, 199], // medium blue
  [0, 0, 234], // dark blue
  [207, 110, 228], // light purple
  [130, 0, 128], // dark Purple
]


/*
const palettePacked = palette.map(arr =>
  (arr[2] << 16) | (arr[1] << 8) | (arr[0])
)*/

// This is an RGB buffer kept up to date with each edit to the indexed buffer.
// Maintaining this makes encoding the png a bit faster (320ms -> 250ms),
// although I'm not sure if the complexity is really worth it.
const imgBuffer = new Buffer(1000 * 1000 * 3)

{
  for (let y = 0; y < 1000; y++) {
    for (let x = 0; x < 1000; x++) {
      const px = y * 1000 + x
      
      //const color = palette[randInt(16)]//palette[imgData[px]]
      const color = palette[imgData[px]]
      imgBuffer[px*3] = color[0]
      imgBuffer[px*3+1] = color[1]
      imgBuffer[px*3+2] = color[2]
    }
  }
}

const setRaw = (x, y, index) => {
  const px = y * 1000 + x
  imgData[px] = index

  const color = palette[index]
  imgBuffer[px*3] = color[0]
  imgBuffer[px*3+1] = color[1]
  imgBuffer[px*3+2] = color[2]
}

app.get('/', (req, res) => res.redirect('/sp/'))

app.get('/sp/current', (req, res) => {

  const resHeaders = {
    // Weirdly, setting this to a lower value is sort of good because it means
    // we won't have to keep as many clients up to date.
    //
    // Using expires instead of cache-control because nginx isn't decrementing
    // the max-age parameter as the document gets older.
    //'cache-control': 'public; max-age=300',
    'expires': new Date(Date.now() + 10 * 1000).toUTCString(), // 10 seconds.
    //'age': '0',
  }

  if (fresh(req.headers, resHeaders)) {
    //console.log('cached!')
    res.statusCode = 304
    return res.end()
  }

  // This takes about 300ms to load.
  res.setHeader('content-type', 'image/png')
  res.setHeader('x-content-version', version)

  for (const k in resHeaders) res.setHeader(k, resHeaders[k])

  // TODO: Find a PNG encoder which supports indexed pngs. It'll be way faster that way.
  const img = new PNG({
    width: 1000, height: 1000,
    colorType: 2, // color but no alpha
    bitDepth: 8,
    inputHasAlpha: false,
  })

  img.data = imgBuffer
  img.pack().pipe(res)
})

// This is a buffer containing a bunch of recent operations. 
let opbase = 0
const opbuffer = []

let lasthead = 0
setInterval(() => {
  // Trim the op buffer down to size. The buffer only needs to store ops for
  // the amount of cache time + expected latency time.
  
  //console.log('opbase', opbase, 'opbuffer', opbuffer.length)
  const newhead = opbase + opbuffer.length

  if (lasthead === 0) {
    // First time through.
    lasthead = newhead
    return
  }

  // Trim everything from opbase -> lasthead
  opbuffer.splice(0, lasthead - opbase)
  opbase = lasthead
  lasthead = newhead
  //console.log('-> opbase', opbase, 'opbuffer', opbuffer.length, 'lasthead', lasthead)
}, 20000)


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

const decodeEdit = (buffer, offset) => { // returns x, y, color.
  const xx = buffer[offset]
  const yx = buffer[offset + 1]
  const cy = buffer[offset + 2]

  const x = xx | ((yx & 0x3) << 8)
  const y = (yx >>> 2) | ((cy & 0xf) << 6)
  const c = cy >> 4

  return [x, y, c]
}

{
  // Lets just check.
  const b = new Buffer(3)
  encodeEditTo(b, 0, 333, 666, 15)
  assert.deepEqual(decodeEdit(b, 0), [333, 666, 15])
}

//const buffer = new Buffer(1000 * 1000) // 1MB should be plenty.

// This is sort of gross. I'm using it to send a fast-start to clients. It
// could be optimized to only send one message instead of one per read.
function pack(v, data) {
  if (Array.isArray(data)) {
    const [x, y, color] = data

    const b = new Buffer(4 + 3)
    b.writeUInt32LE(v, 0)
    encodeEditTo(b, 4, x, y, color)
    return b
  } else {
    const b = new Buffer(4 + data.length)
    b.writeUInt32LE(v, 0)
    data.copy(b, 4)
    return b
  }
}

// WS feed
wss.on('connection', client => {
  const fromstr = url.parse(client.upgradeReq.url, true).query.from

  const err = (message) => {
    client.send("error: " + message)
    client.close()
    console.error('WS Error', message)
  }

  if (fromstr == null || isNaN(+fromstr)) return err('Invalid from= parameter')
  const from = (fromstr|0) + 1

  if (from < opbase) {
    client.send('reload')
    client.close()
    return
  }
  
  //console.log('client connected at version', from, 'and were at', opbase + opbuffer.length)
  for (let i = from - opbase; i < opbuffer.length; i++) client.send(pack(i + opbase, opbuffer[i]))

  client.on('message', msg => {
    // TODO: Allow edits here via WS instead of HTTP.
  })
})



// Server-sent events feed.
app.get('/sp/changes', (req, res, next) => {
  // TODO: Add a local buffer and serve recent operations out of that.
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-cache')

  // Make the client refresh their browser so they pick up the new WS code.
  res.write('\n')
  res.write('data: refresh\n\n')
  res.end()
})

const kproducer = new kafka.Producer(kclient)

const inRange = (x, min, max) => (x >= min && x < max)

function doNothing() {}

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


const editsByAddress = new Map
const getDef = (map, key, deffn) => {
  let val = map.get(key)
  if (val == null) {
    val = deffn()
    map.set(key, val)
  }
  return val
}

setInterval(() => {
  editsByAddress.clear()
}, 10000)

app.post('/sp/edit', (req, res, next) => {
  if (req.query.x == null || req.query.y == null || req.query.c == null) return next(Error('Invalid query'))
  const x = req.query.x|0, y = req.query.y|0, c = req.query.c|0
  if (!inRange(x, 0, 1000) || !inRange(y, 0, 1000) || !inRange(c, 0, 16)) return next(Error('Invalid value'))

  // Simple rate limiting. Only allow 10 edits per 10 second window.
  const address = req.headers['x-forwarded-for'] || req.connection.remoteAddress
  const edits = getDef(editsByAddress, address, () => 0)
  // Rate limited. haha.
  if (edits > 10) return res.sendStatus(403)
  editsByAddress.set(address, edits + 1)
  
  processEdit(x, y, c, err => {
    if (err) next(err)
    else res.end()
  })
})


/*
setInterval(() => {
  processEdit(randInt(10), randInt(10), randInt(16))
  processEdit(randInt(10), randInt(10), randInt(16))
  processEdit(randInt(10), randInt(10), randInt(16))
  processEdit(randInt(10), randInt(10), randInt(16))
}, 10)
*/

const broadcastPack = (() => {
  let version = -1
  const buffer = new Buffer(1000 * 100 * 3) // Way bigger than we need.
  let pos = 4

  return makeAggregator(500, (pack, v) => {
    version = v
    pack.copy(buffer, pos)
    pos += pack.length
  }, () => {
    buffer.writeUInt32LE(version, 0)

    const slice = buffer.slice(0, pos)
    for (const c of wss.clients) // OPEN
      if (c.readyState === 1) c.send(slice)

    pos = 4
  })
})()


// Buffer up 1000 operations from the server.
opbase = Math.max(version - 1000, 0)
const kconsumer = new kafka.Consumer(kclient, [{topic: 'sephsplace', offset: opbase}], {
  encoding: 'buffer',
  fromOffset: true,
})
kconsumer.on('message', _msg => {
  const offset = _msg.offset
  if (offset !== opbase + opbuffer.length) {
    console.error('ERROR DOES NOT MATCH', offset, opbase, opbuffer.length, opbase + opbuffer.length)
    return
  }

  const msg = msgpack.decode(_msg.value)
  const type = msg[0]
  switch(type) {
    case 0: {
      // Single edit.
      const [_, x, y, color] = msgpack.decode(_msg.value)

      const msgout = [x, y, color]
      opbuffer[offset - opbase] = msgout
      //console.log('got normal message', x, y, color)

      if (offset > version) {
        setRaw(x, y, color)

        const b = new Buffer(3)
        encodeEditTo(b, 0, x, y, color)
        broadcastPack(b, offset)
      }

      break
    }

    case 1: {
      // Pack of many encoded xyc values.
      const buf = msg[1]
      opbuffer[offset - opbase] = buf

      //console.log('got pack', buf.length / 3)

      for (let off = 0; off < buf.length; off += 3) {
        const [x,y,c] = decodeEdit(buf, off)
        setRaw(x, y, c)
      }

      broadcastPack(buf, offset)

      break

    }

    default:
      throw Error('Cannot decode kafka message of type ' + type)
  }


  if (offset > version) {
    assert(offset === version + 1)

    version = offset

    if (version % 50 === 0) {
      // Commit the updated data.
      console.log((new Date()).toISOString(), 'committing version', offset)

      const txn = dbenv.beginTxn()
      txn.putBinary(snapshotdb, 'current', imgData)
      txn.putNumber(snapshotdb, 'version', offset)
      txn.commit()
    }
  }
})

const port = process.env.PORT || 3211
kproducer.once('ready', () => {
  kproducer.createTopics(['sephsplace'], false, (err) => {
    if (err) {
      console.error('Could not create topic')
      throw err
    }

    server.listen(port, () => {
      console.log('listening on port', port)
    })
  })
})

