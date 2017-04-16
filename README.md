# Reddit r/place in a weekend throwdown!

Soooo, I said I could implement r/place (minus mobile support) in a weekend.
Someone called me on it, so I did it.

[Go check it out](https://josephg.com/sp)

[Postmortem writeup](https://josephg.com/blog/rplace-in-a-weekend/)
[Original HN thread](https://news.ycombinator.com/item?id=14112085)


## Design

> This was written when I started the project. You're better off taking a look
> at the [postmortem blog post](https://josephg.com/blog/rplace-in-a-weekend/)
> for details about how it works.

The actual image edits will all be sent to Kafka. Each server (well, kafka client) will host a snapshot of the place image which it will serve.

Now, the entire image will actually be kind of big and slow to png-encode. We
can't re-encode it all the time. So instead I'm going to only regenerate the
image every 100 edits or something and aggressively cache it in nginx.

That means the client will see an old version of the image. To get around that
(and to allow people to see pixels change in realtime) I'm going to add a
server-sent events endpoint which will allow the client to subscribe from a
given image version.

So:

Reads:

- Client gets image, which may be a bit old. Image fetch hits nginx, which will
respond with a cached copy 99% of the time. Response header contains image
version (eg, 1000). If the image is not in cache it is generated in the node
server.
- Client hits `/edits?v=1000` or something. They get back a stream of edits
from the specified version. The client applies those edits locally to the image
they downloaded.

Writes:

- Client sends a POST request with the desired edit (x, y, value) to `/edit`.
Server sends message to kafka.
- Client sees their own write once they get back a message from the
eventstream. If I have time I'll make their edit speculatively visible in the
client before they see it in the server data.

Using this architecture I can spin up as many servers as I want to handle the
load. Writes are all sent through kafka, which can handle millions of edits
per second.

When the server starts it needs to load the current data. Instead of replaying
the entire kafka event log, the client will store a local snapshot in lmdb
containing a recent copy of the image data.

There's a fair few moving parts that all need to be kept in sync: kafka,
server, client, lmdb. But all the data flows one way (client -> server ->
kafka -> client) and ({lmdb, kafka} -> server -> {lmdb, kafka}). So it should
be mostly straightforward. I hope.


---

# License

ISC License

Copyright (c) 2017 Joseph Gentle

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
