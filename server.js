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

const app = require('express')()

const PNG = require('pngjs').PNG

const kafka = require('kafka-node')



// This is important so we can hot-resume when the server starts without
// needing to read the entire kafka log. A file would almost be good enough,
// but we need to atomically write to it. So, this is easier.
const dbenv = new lmdb.Env()

const fs = require('fs')
if (!fs.existsSync('snapshot')) fs.mkdirSync('snapshot')
dbenv.open({ path: 'snapshot', mapSize: 10*1024*1024 })
const snapshotdb = dbenv.openDbi({create: true})


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

  [131, 0, 124], // dark Purple
  [207, 109, 223], // light purple
  [255,165,207], // pink
  [234, 0, 9], // red

  [233, 216, 59], // yellow
  [233, 147, 39], // orange
  
  [0, 213, 220], // cyan
  [0, 133, 195], // medium blue
  [0, 18, 227], // dark blue

  [149, 224, 89], // light green
  [0, 191, 49], // green

  [163, 105, 170], // brown
]

/*
const palettePacked = palette.map(arr =>
  (arr[2] << 16) | (arr[1] << 8) | (arr[0])
)*/

const imgBuffer = new Buffer(1000 * 1000 * 3)

{
  for (let y = 0; y < 1000; y++) {
    for (let x = 0; x < 1000; x++) {
      const px = y * 1000 + x
      
      const color = palette[imgData[px]]
      //console.log(px, imgData[px], palette[imgData[px]])
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

const randInt = max => (Math.random() * max) | 0
/*
{
  imgBuffer.fill(0xcc)
  for (let i = 0; i < 1000000; i++) setRaw(randInt(1000), randInt(1000), randInt(16))
}*/

app.get('/current', (req, res) => {
  // This takes about 300ms to load.
  res.setHeader('content-type', 'image/png')
  res.setHeader('x-content-version', version)

  // It'd be nice to build an indexed color png, but whatever.
  const img = new PNG({
    width: 1000, height: 1000,
    colorType: 2,
    bitDepth: 8,
    inputHasAlpha: false,
  })

  img.data = imgBuffer
  img.pack().pipe(res)
})


const kclient = new kafka.Client()
const kproducer = new kafka.Producer(kclient)
app.post('/edit', (req, res) => {
  kproducer.send([{
    topic: 'test',
    // message type 0, x, y, color.
    messages: [msgpack.encode([0, 0, 0, randInt(16)])],
  }], (err, data) => {
    console.log(err, data)
    res.end()
  })
})

const kconsumer = new kafka.Consumer(kclient, [{topic: 'test', offset: version + 1}], {
  encoding: 'buffer',
  fromOffset: true,
})
kconsumer.on('message', msg => {
  const [type, x, y, color] = msgpack.decode(msg.value)
  console.log('got message', x, y, color, msg)

  for (let x = 0; x < 100; x++) {
    for (let y = 0; y < 100; y++) {
      setRaw(x, y, color)
    }
  }

  version = msg.offset

  if (version % 10 === 0) {
    // Commit the updated data.
    console.log('committing version', msg.offset)

    const txn = dbenv.beginTxn()
    txn.putBinary(snapshotdb, 'current', imgData)
    txn.putNumber(snapshotdb, 'version', msg.offset)
    txn.commit()
  }

})

kproducer.once('ready', () => {
  require('http').createServer(app).listen(3211, () => {
    console.log('listening on port 3211')
  })
})

