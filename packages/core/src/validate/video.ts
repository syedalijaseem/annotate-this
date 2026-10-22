import type { AnnotationDocument, Region, Track, VideoSource } from "../types.js"
import { type Issue, MAX_ISSUES_PER_CHECK, issue, own, pushAll } from "./issues.js"

/** Frame timing of one video source: exactly one of fps or timestamps, and sane timestamps. */
export function videoSourceIssues(id: string, source: VideoSource): Issue[] {
  const issues: Issue[] = []
  const at = `sources.${id}`
  const hasFps = source.fps !== undefined
  const hasTimestamps = source.timestamps !== undefined
  if (hasFps === hasTimestamps) {
    issues.push(
      issue("INVALID_DOCUMENT", at, "A video source needs exactly one of fps or timestamps"),
    )
  }
  if (source.timestamps) {
    if (source.timestamps.length !== source.frameCount) {
      issues.push(
        issue("INVALID_DOCUMENT", `${at}.timestamps`, "timestamps must have one entry per frame"),
      )
    }
    for (let i = 1; i < source.timestamps.length; i++) {
      if ((source.timestamps[i] as number) <= (source.timestamps[i - 1] as number)) {
        issues.push(
          issue("INVALID_DOCUMENT", `${at}.timestamps`, "timestamps must be strictly increasing"),
        )
        break
      }
    }
  }
  return issues
}

function trackRules(id: string, track: Track, frameCount: number): Issue[] {
  const issues: Issue[] = []
  let previous = -1
  for (const [i, keyframe] of track.keyframes.entries()) {
    if (issues.length >= MAX_ISSUES_PER_CHECK) break
    const at = `tracks.${id}.keyframes.${i}`
    if (keyframe.frame <= previous)
      issues.push(
        issue("INVALID_DOCUMENT", `${at}.frame`, "Keyframes must have strictly increasing frames"),
      )
    if (keyframe.frame >= frameCount)
      issues.push(issue("INVALID_DOCUMENT", `${at}.frame`, `Frame is outside 0..${frameCount - 1}`))
    if (keyframe.geometry.type !== track.geometryType) {
      issues.push(
        issue(
          "INVALID_GEOMETRY",
          `${at}.geometry`,
          `Keyframe geometry must be "${track.geometryType}"`,
        ),
      )
    }
    previous = keyframe.frame
  }
  return issues
}

/** Frame rules for one region: video regions need a frame in range, image regions must not have one. */
export function regionFrameIssue(doc: AnnotationDocument, id: string, region: Region): Issue[] {
  const source = own(doc.sources, region.sourceId)
  if (!source) return []
  const at = `regions.${id}.frame`
  if (source.kind === "image" && region.frame !== undefined) {
    return [issue("INVALID_DOCUMENT", at, "Regions on an image must not have a frame")]
  }
  if (source.kind === "video" && region.frame === undefined) {
    return [issue("INVALID_DOCUMENT", at, "Regions on a video need a frame")]
  }
  if (source.kind === "video" && region.frame !== undefined && region.frame >= source.frameCount) {
    return [issue("INVALID_DOCUMENT", at, `Frame is outside 0..${source.frameCount - 1}`)]
  }
  return []
}

function regionFrameRules(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = []
  for (const [id, region] of Object.entries(doc.regions))
    pushAll(issues, regionFrameIssue(doc, id, region))
  return issues
}

export function checkVideo(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = regionFrameRules(doc)
  for (const [id, source] of Object.entries(doc.sources)) {
    if (source.kind === "video") pushAll(issues, videoSourceIssues(id, source))
  }
  for (const [id, track] of Object.entries(doc.tracks)) {
    const source = own(doc.sources, track.sourceId)
    if (source?.kind === "video") pushAll(issues, trackRules(id, track, source.frameCount))
  }
  return issues
}
