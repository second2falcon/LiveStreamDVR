import type { PacketScan } from "./PadVideo";
import {
    PacketScanner,
    buildConcatList,
    fillerUnitFrames,
    planPadding,
} from "./PadVideo";

const fps = 60;
const fd = 1 / fps;

/**
 * Scan of a capture starting at 1.4s with a keyframe every 2 seconds,
 * with the given seconds of capture time removed (timestamp gaps), like streamlink does with ads.
 */
function makeScan(
    length: number,
    gaps: { at: number; length: number }[]
): PacketScan {
    const scanner = new PacketScanner(fd);
    let shift = 0;
    const sortedGaps = [...gaps].sort((a, b) => a.at - b.at);
    for (let frame = 0; frame < length * fps; frame++) {
        const t = frame / fps;
        const gap = sortedGaps.find((g) => Math.abs(g.at - t) < fd / 2);
        if (gap) shift += gap.length;
        const dts = 1.4 + t + shift;
        const keyframe = frame % (2 * fps) == 0;
        scanner.addLine(
            `${(dts + 2 * fd).toFixed(6)},${dts.toFixed(6)},${
                keyframe ? "K__" : "___"
            }`
        );
    }
    const scan = scanner.result();
    if (!scan) throw new Error("no scan");
    return scan;
}

describe("PacketScanner", () => {
    it("finds timestamp gaps and keyframes", () => {
        const scan = makeScan(60, [{ at: 20, length: 16 }]);
        expect(scan.start).toBeCloseTo(1.4 + 2 * fd);
        expect(scan.gaps).toHaveLength(1);
        expect(scan.gaps[0].length).toBeCloseTo(16);
        expect(scan.keyframes).toHaveLength(30);
    });

    it("estimates the frame duration if not given", () => {
        const scanner = new PacketScanner();
        for (let i = 0; i < 100; i++)
            scanner.addLine(`${i / 30},${i / 30},___`);
        const scan = scanner.result();
        expect(scan && scan.frameDuration).toBeCloseTo(1 / 30);
    });

    it("ignores invalid lines", () => {
        const scanner = new PacketScanner(fd);
        scanner.addLine("N/A,N/A,K__");
        scanner.addLine("");
        expect(scanner.result()).toBe(false);
    });
});

describe("planPadding", () => {
    it("places filler exactly at matching timestamp gaps", () => {
        const scan = makeScan(54, [
            { at: 20, length: 16 },
            { at: 44, length: 20 },
        ]);
        // pauses as recorded by streamlink logs, a bit off
        const plan = planPadding(scan, [
            { start: 20.4, end: 36.3 },
            { start: 60.3, end: 80.5 },
        ]);
        expect(plan.matchedPauses).toBe(2);
        expect(plan.estimatedPauses).toBe(0);
        expect(plan.collapsedGaps).toBe(0);
        expect(plan.totalFiller).toBeCloseTo(36);
        expect(plan.parts.map((p) => p.type)).toEqual([
            "source",
            "filler",
            "source",
            "filler",
            "source",
        ]);

        const [first, , second, , third] = plan.parts;
        expect(first.type == "source" && first.inpoint).toBe(undefined);
        expect(first.type == "source" && first.outpoint).toBeCloseTo(1.4 + 20);
        // continues at the keyframe dts after the gap
        expect(second.type == "source" && second.inpoint).toBeCloseTo(1.4 + 36);
        expect(third.type == "source" && third.inpoint).toBeCloseTo(
            1.4 + 44 + 36
        );
    });

    it("estimates the position when there are no timestamp gaps", () => {
        const scan = makeScan(54, []);
        const plan = planPadding(scan, [
            { start: 20.4, end: 36.3 },
            { start: 60.3, end: 80.5 },
        ]);
        expect(plan.matchedPauses).toBe(0);
        expect(plan.estimatedPauses).toBe(2);
        expect(plan.totalFiller).toBeCloseTo(15.9 + 20.2);
        const sources = plan.parts.filter((p) => p.type == "source");
        // snapped to the nearest keyframes, at 20s and 44s of the collapsed video
        expect(sources[0].type == "source" && sources[0].outpoint).toBeCloseTo(
            1.4 + 20
        );
        expect(sources[1].type == "source" && sources[1].inpoint).toBeCloseTo(
            1.4 + 20
        );
        expect(sources[1].type == "source" && sources[1].outpoint).toBeCloseTo(
            1.4 + 44
        );
    });

    it("collapses gaps without a matching pause like a normal conversion", () => {
        const scan = makeScan(54, [{ at: 30, length: 12 }]);
        const plan = planPadding(scan, []);
        expect(plan.collapsedGaps).toBe(1);
        expect(plan.totalFiller).toBe(0);
        expect(plan.parts.map((p) => p.type)).toEqual(["source", "source"]);
    });

    it("does not match a gap of a very different length", () => {
        const scan = makeScan(54, [{ at: 20, length: 60 }]);
        const plan = planPadding(scan, [{ start: 20, end: 36 }]);
        expect(plan.matchedPauses).toBe(0);
        expect(plan.estimatedPauses).toBe(1);
        expect(plan.collapsedGaps).toBe(1);
    });

    it("puts filler for a pause at the start before the first frame", () => {
        const scan = makeScan(30, []);
        const plan = planPadding(scan, [{ start: 0, end: 15 }]);
        expect(plan.parts[0]).toEqual({ type: "filler", duration: 15 });
        expect(plan.parts[1]).toEqual({ type: "source", inpoint: undefined });
    });

    it("merges pauses that snap to the same keyframe", () => {
        const scan = makeScan(30, []);
        const plan = planPadding(scan, [
            { start: 10, end: 11 },
            { start: 11.2, end: 12 },
        ]);
        expect(plan.parts.filter((p) => p.type == "filler")).toHaveLength(1);
        expect(plan.totalFiller).toBeCloseTo(1.8);
    });
});

describe("fillerUnitFrames", () => {
    it("is a whole number of video and aac frames", () => {
        for (const [rate, sampleRate] of [
            [60, 48000],
            [30, 48000],
            [30000 / 1001, 48000],
            [60, 44100],
        ]) {
            const frames = fillerUnitFrames(rate, sampleRate);
            const seconds = frames / rate;
            const aacFrames = (seconds * sampleRate) / 1024;
            expect(Math.abs(aacFrames - Math.round(aacFrames))).toBeLessThan(
                1e-6
            );
            expect(seconds).toBeGreaterThanOrEqual(4);
        }
    });
});

describe("buildConcatList", () => {
    it("repeats the filler unit and trims the last one", () => {
        const list = buildConcatList(
            {
                parts: [
                    { type: "source", outpoint: 21.4 },
                    { type: "filler", duration: 10 },
                    { type: "source", inpoint: 37.4 },
                ],
                matchedPauses: 1,
                estimatedPauses: 0,
                collapsedGaps: 0,
                totalFiller: 10,
                messages: [],
            },
            "/data/it's.ts",
            "/cache/filler.ts",
            1.4,
            4
        );
        expect(list).toBe(
            [
                "ffconcat version 1.0",
                "file '/data/it'\\''s.ts'",
                "outpoint 21.400000",
                "file '/cache/filler.ts'",
                "duration 4.000000",
                "file '/cache/filler.ts'",
                "duration 4.000000",
                "file '/cache/filler.ts'",
                "outpoint 3.400000",
                "duration 2.000000",
                "file '/data/it'\\''s.ts'",
                "inpoint 37.400000",
                "",
            ].join("\n")
        );
    });
});
