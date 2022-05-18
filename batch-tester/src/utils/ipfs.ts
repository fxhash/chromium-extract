import appendQuery from "append-query"

export function getIpfsUrl(cid: string) {
  return `${process.env.IPFS_GATEWAY_ROOT}/ipfs/${cid}`
}

/**
 * Given a CID (either {cid} or {cid?fxhash=hash}), outputs an URL to query the capture
 * module with
 */
export function buildCaptureUrlFromCid(cid: string) {
  return appendQuery(getIpfsUrl(cid), "preview=1")
}