import type { TwitchComment, TwitchCommentDumpTD } from "@common/Comments";
import {
    pausesToIntervals,
    streamTimeToVideoTime,
    syncChatDumpToVideo,
    totalPauseDuration,
} from "./StreamPauses";

// capture 43333681128, a real stream with 8 ad breaks
const started_at = new Date("2024-12-08T13:47:21.000Z");
const pauses = [
    ["2024-12-08T13:47:37.022Z", "2024-12-08T13:47:52.090Z"],
    ["2024-12-08T14:49:27.406Z", "2024-12-08T14:51:02.077Z"],
    ["2024-12-08T15:47:47.205Z", "2024-12-08T15:49:52.073Z"],
    ["2024-12-08T16:09:47.309Z", "2024-12-08T16:11:52.038Z"],
    ["2024-12-08T16:34:52.405Z", "2024-12-08T16:35:57.090Z"],
    ["2024-12-08T16:48:49.121Z", "2024-12-08T16:50:52.053Z"],
    ["2024-12-08T16:57:29.045Z", "2024-12-08T16:58:32.088Z"],
    ["2024-12-08T17:22:07.156Z", "2024-12-08T17:24:12.100Z"],
].map(([start, end]) => ({ start: new Date(start), end: new Date(end) }));

const secondsSinceStart = (iso: string) =>
    (new Date(iso).getTime() - started_at.getTime()) / 1000;

describe("pausesToIntervals", () => {
    it("converts the example stream pauses", () => {
        const intervals = pausesToIntervals(pauses, started_at);
        expect(intervals).toHaveLength(8);
        expect(intervals[0].start).toBeCloseTo(16.022);
        expect(intervals[0].end).toBeCloseTo(31.09);
        expect(totalPauseDuration(intervals)).toBeCloseTo(734.94, 1);
    });

    it("returns nothing without pauses", () => {
        expect(pausesToIntervals([], started_at)).toEqual([]);
    });

    it("ignores negligible pauses", () => {
        expect(
            pausesToIntervals(
                [
                    {
                        start: new Date("2024-12-08T14:00:00.000Z"),
                        end: new Date("2024-12-08T14:00:00.500Z"),
                    },
                ],
                started_at
            )
        ).toEqual([]);
    });

    it("drops invalid pauses and merges overlapping ones", () => {
        const intervals = pausesToIntervals(
            [
                {
                    start: new Date("2024-12-08T14:00:30.000Z"),
                    end: new Date("2024-12-08T14:01:30.000Z"),
                },
                {
                    start: new Date("2024-12-08T14:00:00.000Z"),
                    end: new Date("2024-12-08T14:01:00.000Z"),
                },
                {
                    start: new Date("2024-12-08T15:00:00.000Z"),
                    end: new Date("2024-12-08T14:59:00.000Z"),
                },
                { start: new Date("2024-12-08T15:00:00.000Z") },
                {
                    start: new Date("invalid"),
                    end: new Date("2024-12-08T15:00:00.000Z"),
                },
            ],
            started_at
        );
        expect(intervals).toHaveLength(1);
        expect(intervals[0].end - intervals[0].start).toBeCloseTo(90);
    });
});

describe("streamTimeToVideoTime", () => {
    const intervals = pausesToIntervals(pauses, started_at);

    it("does not change anything without pauses", () => {
        expect(streamTimeToVideoTime(1234.5, [])).toBe(1234.5);
    });

    it("does not move times before the first pause", () => {
        expect(streamTimeToVideoTime(10, intervals)).toBe(10);
    });

    it("moves times after a pause back by the pause duration", () => {
        // 1:00:00 into the stream, only the pre-roll has passed
        expect(streamTimeToVideoTime(3600, intervals)).toBeCloseTo(
            3600 - 15.068
        );
        // 2:00:00, pre-roll and first mid-roll
        expect(streamTimeToVideoTime(7200, intervals)).toBeCloseTo(
            7200 - 15.068 - 94.671
        );
    });

    it("moves times after the last pause back by all pauses", () => {
        const end = secondsSinceStart("2024-12-08T18:25:32.134Z");
        expect(end - streamTimeToVideoTime(end, intervals)).toBeCloseTo(
            734.94,
            1
        );
    });

    it("maps times inside a pause to the cut point", () => {
        const pauseStart = secondsSinceStart("2024-12-08T14:49:27.406Z");
        const cut = streamTimeToVideoTime(pauseStart, intervals);
        expect(streamTimeToVideoTime(pauseStart + 30, intervals)).toBeCloseTo(
            cut
        );
        expect(streamTimeToVideoTime(pauseStart + 94, intervals)).toBeCloseTo(
            cut
        );
    });

    it("is monotonic", () => {
        let last = -1;
        for (let t = 0; t < 17000; t += 7) {
            const v = streamTimeToVideoTime(t, intervals);
            expect(v).toBeGreaterThanOrEqual(last);
            last = v;
        }
    });

    it("maps the second chapter of the example stream", () => {
        const chapter = secondsSinceStart("2024-12-08T15:47:34.092Z");
        expect(chapter).toBeCloseTo(7213.092);
        expect(streamTimeToVideoTime(chapter, intervals)).toBeCloseTo(
            7213.092 - 109.739
        );
    });
});

describe("syncChatDumpToVideo", () => {
    const comment = (id: string, offset: number) =>
        ({
            _id: id,
            content_offset_seconds: offset,
        }) as unknown as TwitchComment;

    const dump = {
        comments: [
            comment("a", 10),
            comment("b", 50),
            comment("c", 40),
            comment("d", 100),
        ],
        video: {
            title: "Chat Dump",
            description: "",
            id: "",
            created_at: "",
            start: 0,
            end: 100,
            length: 100,
            viewCount: 0,
            game: "",
            chapters: [],
        },
        embeddedData: null,
    } as TwitchCommentDumpTD;

    it("maps offsets, collapses comments during pauses and keeps order", () => {
        const result = syncChatDumpToVideo(dump, [{ start: 20, end: 60 }]);
        expect(
            result.comments.map((c) => [c._id, c.content_offset_seconds])
        ).toEqual([
            ["a", 10],
            ["b", 20],
            ["c", 20],
            ["d", 60],
        ]);
        expect(result.video.length).toBe(60);
        expect(result.video.end).toBe(60);
    });

    it("does not modify the original dump", () => {
        syncChatDumpToVideo(dump, [{ start: 20, end: 60 }]);
        expect(dump.comments[1].content_offset_seconds).toBe(50);
        expect(dump.video.length).toBe(100);
    });
});
