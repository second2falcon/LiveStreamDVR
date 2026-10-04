import type { PauseInterval } from "./StreamPauses";
import { streamTimeToVideoTime } from "./StreamPauses";

/**
 * Filling stream pauses (ad breaks) with black video when converting a capture.
 *
 * Streamlink drops the ad segments, so the captured video is shorter than the stream
 * and everything timed against the stream (chat, chapters) drifts after every ad break.
 * Here the capture is cut at each pause and a black, silent filler of the pause length
 * is inserted, using only stream copy for the capture itself.
 *
 * The cut points are taken from timestamp jumps in the capture when they match a recorded
 * pause, otherwise they are estimated from the recorded pause times and snapped to a keyframe.
 */

/** Timestamp jumps shorter than this are not considered gaps */
export const GAP_MIN_SECONDS = 5;

/** How far (in seconds) a timestamp gap may be from the expected pause position to match it */
export const GAP_MATCH_POSITION_TOLERANCE = 60;

export interface Keyframe {
    pts: number;
    dts: number;
}

export interface TimestampGap {
    /** dts of the last video packet before the gap */
    before: number;
    /** dts of the first video packet after the gap */
    after: number;
    /** missing time in seconds */
    length: number;
}

/** Result of scanning the video packets of a capture */
export interface PacketScan {
    /** pts of the first video packet */
    start: number;
    /** dts of the last video packet */
    end: number;
    frameDuration: number;
    /** sorted by pts */
    keyframes: Keyframe[];
    /** sorted by position */
    gaps: TimestampGap[];
}

export type PadPart =
    | {
          type: "source";
          /**
           * timestamp in the capture to start at, the dts of a keyframe.
           * using the pts makes the concat demuxer start after the keyframe and break decoding
           */
          inpoint?: number;
          /** dts in the capture to stop at */
          outpoint?: number;
      }
    | {
          type: "filler";
          duration: number;
      };

export interface PadPlan {
    parts: PadPart[];
    /** pauses placed exactly at a timestamp gap */
    matchedPauses: number;
    /** pauses placed at an estimated position */
    estimatedPauses: number;
    /** timestamp gaps without a matching pause, collapsed like a normal conversion */
    collapsedGaps: number;
    totalFiller: number;
    messages: string[];
}

interface Cut {
    /** sort key, position in the capture */
    position: number;
    /** dts to stop the previous source part at, undefined to insert before the first frame */
    outpoint?: number;
    /** keyframe dts to continue at, undefined if the capture ends here */
    inpoint?: number;
    filler: number;
}

/**
 * Scan ffprobe packet output lines (`pts_time,dts_time,flags`) of a video stream.
 */
export class PacketScanner {
    private start?: number;
    private lastDts?: number;
    private keyframes: Keyframe[] = [];
    private gaps: { before: number; after: number }[] = [];
    private deltas: number[] = [];

    public constructor(private frameDuration?: number) {}

    public addLine(line: string): void {
        const [ptsText, dtsText, flags] = line.trim().split(",");
        const pts = parseFloat(ptsText);
        const dts = parseFloat(dtsText);
        if (isNaN(dts)) return;

        if (this.start === undefined && !isNaN(pts)) this.start = pts;

        if (flags && flags.includes("K") && !isNaN(pts)) {
            this.keyframes.push({ pts, dts });
        }

        if (this.lastDts !== undefined) {
            const delta = dts - this.lastDts;
            if (delta >= GAP_MIN_SECONDS) {
                this.gaps.push({ before: this.lastDts, after: dts });
            } else if (this.deltas.length < 500 && delta > 0) {
                this.deltas.push(delta);
            }
        }

        this.lastDts = dts;
    }

    public result(): PacketScan | false {
        if (this.start === undefined || this.lastDts === undefined) {
            return false;
        }

        let frameDuration = this.frameDuration;
        if (!frameDuration) {
            if (this.deltas.length == 0) return false;
            const sorted = [...this.deltas].sort((a, b) => a - b);
            frameDuration = sorted[Math.floor(sorted.length / 2)];
        }

        return {
            start: this.start,
            end: this.lastDts,
            frameDuration,
            keyframes: [...this.keyframes].sort((a, b) => a.pts - b.pts),
            gaps: this.gaps.map((g) => ({
                ...g,
                length: g.after - g.before - (frameDuration as number),
            })),
        };
    }
}

function firstKeyframeAtOrAfter(
    keyframes: Keyframe[],
    time: number
): Keyframe | undefined {
    return keyframes.find((k) => k.pts >= time - 0.001);
}

function nearestKeyframe(
    keyframes: Keyframe[],
    time: number
): Keyframe | undefined {
    let best: Keyframe | undefined;
    for (const k of keyframes) {
        if (!best || Math.abs(k.pts - time) < Math.abs(best.pts - time)) {
            best = k;
        }
    }
    return best;
}

/**
 * Plan where to cut the capture and how much filler to insert.
 *
 * @param scan video packet scan of the capture
 * @param intervals stream pauses in seconds since the stream started
 */
export function planPadding(
    scan: PacketScan,
    intervals: PauseInterval[]
): PadPlan {
    const messages: string[] = [];

    // position of each gap in the collapsed timeline (all gaps removed), like a normal conversion
    let removedBefore = 0;
    const gaps = scan.gaps.map((gap) => {
        const collapsed =
            gap.before + scan.frameDuration - scan.start - removedBefore;
        removedBefore += gap.length;
        return { ...gap, collapsed, matched: false };
    });

    const cuts: Cut[] = [];
    let matchedPauses = 0;
    let estimatedPauses = 0;

    for (const pause of intervals) {
        const duration = pause.end - pause.start;
        // where the pause is in the collapsed video, assuming the video starts when the stream started
        const expected = streamTimeToVideoTime(pause.start, intervals);

        let match: (typeof gaps)[number] | undefined;
        for (const gap of gaps) {
            if (gap.matched) continue;
            if (
                Math.abs(gap.collapsed - expected) >
                GAP_MATCH_POSITION_TOLERANCE
            )
                continue;
            if (Math.abs(gap.length - duration) > Math.max(10, duration * 0.25))
                continue;
            if (
                !match ||
                Math.abs(gap.collapsed - expected) <
                    Math.abs(match.collapsed - expected)
            ) {
                match = gap;
            }
        }

        if (match) {
            match.matched = true;
            matchedPauses++;
            const resume = firstKeyframeAtOrAfter(scan.keyframes, match.after);
            cuts.push({
                position: match.before,
                outpoint: match.before + scan.frameDuration,
                inpoint: resume?.dts,
                filler: match.length,
            });
            messages.push(
                `Pause at ${expected.toFixed(1)}s (${duration.toFixed(
                    1
                )}s) matched timestamp gap at ${match.collapsed.toFixed(
                    1
                )}s (${match.length.toFixed(1)}s)`
            );
            continue;
        }

        // no gap, estimate the position in the capture and snap it to a keyframe
        estimatedPauses++;
        const gapsBefore = gaps
            .filter((g) => g.collapsed <= expected)
            .reduce((acc, g) => acc + g.length, 0);
        const target = scan.start + expected + gapsBefore;

        if (target <= scan.start + scan.frameDuration) {
            cuts.push({ position: scan.start, filler: duration });
        } else if (target >= scan.end) {
            cuts.push({
                position: scan.end,
                outpoint: scan.end + scan.frameDuration,
                filler: duration,
            });
        } else {
            const keyframe = nearestKeyframe(scan.keyframes, target);
            if (!keyframe || keyframe.pts <= scan.start) {
                cuts.push({ position: scan.start, filler: duration });
            } else {
                cuts.push({
                    position: keyframe.pts,
                    outpoint: keyframe.dts,
                    inpoint: keyframe.dts,
                    filler: duration,
                });
            }
        }
        messages.push(
            `Pause at ${expected.toFixed(1)}s (${duration.toFixed(
                1
            )}s) has no timestamp gap, placed at the nearest keyframe`
        );
    }

    // gaps without a pause (e.g. network issues) are collapsed, like a normal conversion
    let collapsedGaps = 0;
    for (const gap of gaps) {
        if (gap.matched) continue;
        collapsedGaps++;
        const resume = firstKeyframeAtOrAfter(scan.keyframes, gap.after);
        cuts.push({
            position: gap.before,
            outpoint: gap.before + scan.frameDuration,
            inpoint: resume?.dts,
            filler: 0,
        });
        messages.push(
            `Timestamp gap at ${gap.collapsed.toFixed(
                1
            )}s (${gap.length.toFixed(1)}s) has no matching pause, collapsed`
        );
    }

    cuts.sort((a, b) => a.position - b.position);

    const parts: PadPart[] = [];
    let inpoint: number | undefined = undefined;
    let ended = false;

    for (const cut of cuts) {
        if (ended) {
            // capture already ended, only filler can follow
            if (cut.filler > 0)
                parts.push({ type: "filler", duration: cut.filler });
            continue;
        }

        if (cut.outpoint !== undefined) {
            if (inpoint === undefined || cut.outpoint > inpoint) {
                parts.push({ type: "source", inpoint, outpoint: cut.outpoint });
            }
        }

        if (cut.filler > 0) {
            parts.push({ type: "filler", duration: cut.filler });
        }

        if (cut.outpoint === undefined) {
            // filler before the first frame, the capture continues from where it was
            continue;
        }

        if (cut.inpoint === undefined) {
            ended = true;
        } else {
            inpoint = cut.inpoint;
        }
    }

    if (!ended) {
        parts.push({ type: "source", inpoint });
    }

    // merge adjacent fillers
    const merged: PadPart[] = [];
    for (const part of parts) {
        const last = merged[merged.length - 1];
        if (part.type == "filler" && last && last.type == "filler") {
            last.duration += part.duration;
        } else {
            merged.push({ ...part });
        }
    }

    const totalFiller = merged.reduce(
        (acc, p) => acc + (p.type == "filler" ? p.duration : 0),
        0
    );

    return {
        parts: merged,
        matchedPauses,
        estimatedPauses,
        collapsedGaps,
        totalFiller,
        messages,
    };
}

/**
 * Number of video frames in one filler unit, chosen so that the unit is a whole number
 * of both video frames and AAC frames (1024 samples), so repeated units don't drift.
 */
export function fillerUnitFrames(
    fps: number,
    sampleRate: number,
    minSeconds = 4
): number {
    let base = Math.max(1, Math.round(fps));
    for (let n = 1; n <= 1024; n++) {
        const aacFrames = (n / fps) * (sampleRate / 1024);
        if (Math.abs(aacFrames - Math.round(aacFrames)) < 1e-6) {
            base = n;
            break;
        }
    }
    const baseSeconds = base / fps;
    return base * Math.max(1, Math.ceil(minSeconds / baseSeconds));
}

function escapeConcatPath(file: string): string {
    return `'${file.replace(/'/g, "'\\''")}'`;
}

/**
 * Write an ffconcat list for the plan.
 *
 * @param source capture file
 * @param filler filler unit file
 * @param fillerStart start_time of the filler file
 * @param fillerUnit duration of the filler unit
 */
export function buildConcatList(
    plan: PadPlan,
    source: string,
    filler: string,
    fillerStart: number,
    fillerUnit: number
): string {
    const lines = ["ffconcat version 1.0"];

    for (const part of plan.parts) {
        if (part.type == "source") {
            lines.push(`file ${escapeConcatPath(source)}`);
            if (part.inpoint !== undefined)
                lines.push(`inpoint ${part.inpoint.toFixed(6)}`);
            if (part.outpoint !== undefined)
                lines.push(`outpoint ${part.outpoint.toFixed(6)}`);
        } else {
            let remaining = part.duration;
            while (remaining > 0.001) {
                const length = Math.min(fillerUnit, remaining);
                lines.push(`file ${escapeConcatPath(filler)}`);
                if (length < fillerUnit - 0.001) {
                    lines.push(`outpoint ${(fillerStart + length).toFixed(6)}`);
                }
                lines.push(`duration ${length.toFixed(6)}`);
                remaining -= length;
            }
        }
    }

    return lines.join("\n") + "\n";
}
