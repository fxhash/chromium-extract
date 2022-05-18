import { Stream } from "stream"
import FileType from "file-type"


export function streamToBuffer(stream: Stream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bufs: any[] = []
    stream.on("data", chunk => bufs.push(chunk))
    stream.on("end", () => resolve(Buffer.concat(bufs)))
    stream.on("error", () => reject())
  })
}

export async function bufferToBase64(buffer: Buffer): Promise<string> {
  const base64 = buffer.toString("base64")  
  const type = await FileType.fromBuffer(buffer)
  if (type) {
    return `data:${type.mime};base64,${base64}`
  }
  else {
    return base64
  }
}