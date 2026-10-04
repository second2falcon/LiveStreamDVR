import type { TwitchComment, TwitchCommentDumpTD } from "@common/Comments";

/**
 * A stream pause (usually an ad break filtered out by streamlink) as an
 * interval in seconds relative to the stream start (started_at).
 */
export interface PauseInterval {
    start: number;
    end: number;
}

/**
 * Pauses shorter than this in total are ignored, the video and chat are
 * considered to be in sync already.
 */
export const MIN_TOTAL_PAUSE_SECONDS = 1;

export function totalPauseDuration(intervals: PauseInterval[]): number {
    return intervals.reduce((acc, p) => acc + (p.end - p.start), 0);
}

/**
 * Convert stream pauses (wall-clock dates) to sorted, non-overlapping
 * intervals in seconds relative to the stream start.
 *
 * Invalid pauses (missing dates, end before start) are dropped,
 * pauses before the stream start are clipped to 0.
 *
 * Returns an empty array if the total pause duration is negligible,
 * meaning no correction should be applied.
 */
export function pausesToIntervals(
    pauses: { start?: Date; end?: Date }[],
    started_at: Date
): PauseInterval[] {
    const base = started_at.getTime();

    const intervals = pauses
        .filter(
            (p): p is { start: Date; end: Date } =>
                p.start instanceof Date &&
                p.end instanceof Date &&
                !isNaN(p.start.getTime()) &&
                !isNaN(p.end.getTime())
        )
        .map((p) => ({
            start: Math.max(0, (p.start.getTime() - base) / 1000),
            end: Math.max(0, (p.end.getTime() - base) / 1000),
        }))
        .filter((p) => p.end > p.start)
        .sort((a, b) => a.start - b.start);

    // merge overlapping intervals
    const merged: PauseInterval[] = [];
    for (const interval of intervals) {
        const last = merged[merged.length - 1];
        if (last && interval.start <= last.end) {
            last.end = Math.max(last.end, interval.end);
        } else {
            merged.push({ ...interval });
        }
    }

    if (totalPauseDuration(merged) < MIN_TOTAL_PAUSE_SECONDS) return [];

    return merged;
}

/**
 * Map a time in the stream (seconds since started_at, how chat and chapters are timed)
 * to a time in the captured video, where the paused sections have been cut out.
 *
 * Times inside a pause are mapped to the point where the pause was cut.
 */
export function streamTimeToVideoTime(
    seconds: number,
    intervals: PauseInterval[]
): number {
    let removed = 0;
    for (const pause of intervals) {
        if (seconds >= pause.end) {
            removed += pause.end - pause.start;
        } else if (seconds > pause.start) {
            removed += seconds - pause.start;
            break;
        } else {
            break;
        }
    }
    return seconds - removed;
}

/**
 * Return a copy of a chat dump with all comment offsets mapped to video time.
 * Comments are sorted by their new offset, the original order is kept for equal offsets.
 */
export function syncChatDumpToVideo(
    dump: TwitchCommentDumpTD,
    intervals: PauseInterval[]
): TwitchCommentDumpTD {
    const comments: TwitchComment[] = dump.comments
        .map((comment, index) => ({
            comment: {
                ...comment,
                content_offset_seconds: streamTimeToVideoTime(
                    comment.content_offset_seconds,
                    intervals
                ),
            },
            index,
        }))
        .sort(
            (a, b) =>
                a.comment.content_offset_seconds -
                    b.comment.content_offset_seconds || a.index - b.index
        )
        .map((c) => c.comment);

    const result: TwitchCommentDumpTD = { ...dump, comments };

    if (dump.video) {
        result.video = {
            ...dump.video,
            start: streamTimeToVideoTime(dump.video.start || 0, intervals),
            end: streamTimeToVideoTime(dump.video.end || 0, intervals),
            length: streamTimeToVideoTime(dump.video.length || 0, intervals),
        };
    }

    return result;
}
