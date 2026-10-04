import { BaseConfigCacheFolder, BaseConfigDataFolder } from "@/Core/BaseConfig";
import { Config } from "@/Core/Config";
import { Helper } from "@/Core/Helper";
import { LOGLEVEL, log } from "@/Core/Log";
import type { FFProbe } from "@common/FFProbe";
import type {
    AudioMetadata,
    MediaInfoJSONOutput,
    MediaInfoObject,
    VideoMetadata,
} from "@common/MediaInfo";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { progressOutput } from "./Console";
import { exec, execSimple, isExecError, startJob } from "./Execute";
import { formatDuration } from "./Format";
import type { PadPlan } from "./PadVideo";
import {
    PacketScanner,
    buildConcatList,
    fillerUnitFrames,
    planPadding,
} from "./PadVideo";
import type { PauseInterval } from "./StreamPauses";
import { spawn } from "node:child_process";
import readline from "node:readline";

export interface RemuxReturn {
    stdout: string[];
    stderr: string[];
    code: number;
    success: boolean;
}

/**
 * Remux input to output
 *
 * @param input
 * @param output
 * @param overwrite
 * @param metadata_file
 * @returns
 */
export async function remuxFile(
    input: string,
    output: string,
    overwrite = false,
    metadata_file?: string,
    /** options placed before the input, e.g. the input format */
    input_options: string[] = []
): Promise<RemuxReturn> {
    const ffmpegPath = Helper.path_ffmpeg();

    if (!ffmpegPath) {
        throw new Error("Failed to find ffmpeg");
    }

    const emptyFile = fs.existsSync(output) && fs.statSync(output).size == 0;

    if (!overwrite && fs.existsSync(output) && !emptyFile) {
        log(
            LOGLEVEL.ERROR,
            "video.remux",
            `Output file ${output} already exists`
        );
        throw new Error(`Output file ${output} already exists`);
    }

    if (emptyFile) {
        fs.unlinkSync(output);
    }

    // ffmpeg seems to make ts cfr into vfr, don't know why

    const opts: string[] = [];
    // "-r", parseInt(info.video.FrameRate).toString(),
    // "-vsync", "cfr",
    opts.push(...input_options);
    opts.push("-i", input);

    // write metadata to file
    if (metadata_file) {
        if (fs.existsSync(metadata_file)) {
            opts.push("-i", metadata_file);
            opts.push("-map_metadata", "1");
        } else {
            log(
                LOGLEVEL.ERROR,
                "video.remux",
                `Metadata file ${metadata_file} does not exist for remuxing ${input}`
            );
        }
    }

    // "-map", "0",
    // "-analyzeduration",

    opts.push("-c", "copy"); // copy all streams

    if (!output.endsWith(Config.AudioContainer)) {
        opts.push("-bsf:a", "aac_adtstoasc"); // audio bitstream filter?
    }

    if (output.endsWith(".mp4")) {
        opts.push("-movflags", "faststart"); // make streaming possible, not sure if this is a good idea
    }

    // "-r", parseInt(info.video.FrameRate).toString(),
    // "-vsync", "cfr",
    // ...ffmpeg_options,
    // output,

    if (overwrite || emptyFile) {
        opts.push("-y");
    }

    if (Config.getInstance().cfg("app_verbose")) {
        opts.push("-loglevel", "repeat+level+verbose");
    }

    if (Config.getInstance().cfg("debug")) {
        // opts.push("-report"); // can't set output file
        opts.push(
            "-progress",
            path.join(BaseConfigDataFolder.logs_software, "ffmpeg_progress.log")
        );
        opts.push("-vstats");
        opts.push(
            "-vstats_file",
            path.join(BaseConfigDataFolder.logs_software, "ffmpeg_vstats.log")
        );
    }

    opts.push(output);

    log(LOGLEVEL.INFO, "video.remux", `Remuxing ${input} to ${output}`);

    let currentSeconds = 0;
    let totalSeconds = 0;

    // const job = startJob(`remux_${path.basename(input)}`, ffmpegPath, opts);

    let job;
    try {
        job = await exec(
            ffmpegPath,
            opts,
            {},
            `remux_${path.basename(input)}`,
            (stream: string, data: string) => {
                const totalDurationMatch = data.match(
                    /Duration: (\d+):(\d+):(\d+)/
                );
                if (totalDurationMatch && !totalSeconds) {
                    totalSeconds =
                        parseInt(totalDurationMatch[1]) * 3600 +
                        parseInt(totalDurationMatch[2]) * 60 +
                        parseInt(totalDurationMatch[3]);
                    console.log(
                        `Remux total duration for ${path.basename(
                            input
                        )}: ${totalSeconds}`
                    );
                }
                if (data.match(/moving the moov atom/)) {
                    console.log(
                        `Create MOOV atom for ${path.basename(
                            input
                        )} (this usually takes a while)`
                    );
                }
            },
            (data: string) => {
                const currentTimeMatch = data.match(/time=(\d+):(\d+):(\d+)/);
                if (currentTimeMatch && totalSeconds > 0) {
                    currentSeconds =
                        parseInt(currentTimeMatch[1]) * 3600 +
                        parseInt(currentTimeMatch[2]) * 60 +
                        parseInt(currentTimeMatch[3]);

                    // console.debug(`Remux current time: ${currentSeconds}/${totalSeconds}`);
                    progressOutput(
                        `🎞 Remuxing ${path.basename(
                            input
                        )} - ${currentSeconds}/${totalSeconds} seconds (${Math.round(
                            (currentSeconds / totalSeconds) * 100
                        )}%)`
                    );
                    return currentSeconds / totalSeconds;
                }
            }
        );
    } catch (error) {
        if (isExecError(error)) {
            log(
                LOGLEVEL.ERROR,
                "video.remux",
                `Failed to remux '${input}' to '${output}': ${error.message}`
            );
            throw error;
        }
    }

    // this should never happen, but type narrowing needs it
    if (!job) {
        throw new Error(
            `Failed to start job for remuxing ${input} to ${output}`
        );
    }

    const success = fs.existsSync(output) && fs.statSync(output).size > 0;

    if (success) {
        log(LOGLEVEL.SUCCESS, "video.remux", `Remuxed ${input} to ${output}`);
        return {
            code: 0,
            success,
            stdout: job.stdout,
            stderr: job.stderr,
        } as RemuxReturn;
    }

    log(
        LOGLEVEL.ERROR,
        "video.remux",
        `Failed to remux '${input}' to '${output}'`
    );

    let message = "Unknown error";
    const errorSearch = job.stderr.join("").match(/\[error\] (.*)/g);
    if (errorSearch && errorSearch.length > 0) {
        message = errorSearch.slice(1).join(", ");
    }

    if (fs.existsSync(output) && fs.statSync(output).size == 0) {
        log(
            LOGLEVEL.ERROR,
            "video.remux",
            `Output file ${output} is empty, removing`
        );
        fs.unlinkSync(output);
    }

    // for (const err of errorSearch) {
    //    message = err[1];
    throw new Error(`Failed to remux '${input}' to '${output}': ${message}`);

    /*
    job.process.on("error", (err) => {
        log(
            LOGLEVEL.ERROR,
            "video.remux",
            `Process ${process.pid} error: ${err.message}`
        );
        // reject({ code: -1, success: false, stdout: job.stdout, stderr: job.stderr });
        reject(new Error(`Process ${process.pid} error: ${err.message}`));
    });

    job.process.on("close", (code) => {
        if (job) {
            job.clear();
        }
        void LiveStreamDVR.getInstance().updateFreeStorageDiskSpace();
        // const out_log = ffmpeg.stdout.read();
        const success = fs.existsSync(output) && fs.statSync(output).size > 0;
        if (success) {
            log(
                LOGLEVEL.SUCCESS,
                "video.remux",
                `Remuxed ${input} to ${output}`
            );
            resolve({
                code: code || -1,
                success,
                stdout: job.stdout,
                stderr: job.stderr,
            });
        } else {
            log(
                LOGLEVEL.ERROR,
                "video.remux",
                `Failed to remux '${input}' to '${output}'`
            );
            // reject({ code, success, stdout: job.stdout, stderr: job.stderr });

            let message = "Unknown error";
            const errorSearch = job.stderr.join("").match(/\[error\] (.*)/g);
            if (errorSearch && errorSearch.length > 0) {
                message = errorSearch.slice(1).join(", ");
            }

            if (fs.existsSync(output) && fs.statSync(output).size == 0) {
                fs.unlinkSync(output);
            }

            // for (const err of errorSearch) {
            //    message = err[1];
            reject(
                new Error(
                    `Failed to remux '${input}' to '${output}': ${message}`
                )
            );
        }
    });
    */
}

export function cutFile(
    input: string,
    output: string,
    start_second: number,
    end_second: number,
    overwrite = false
): Promise<RemuxReturn> {
    return new Promise((resolve, reject) => {
        const ffmpegPath = Helper.path_ffmpeg();

        if (!ffmpegPath) {
            reject(new Error("Failed to find ffmpeg"));
            return;
        }

        const emptyFile =
            fs.existsSync(output) && fs.statSync(output).size == 0;

        if (!overwrite && fs.existsSync(output) && !emptyFile) {
            log(
                LOGLEVEL.ERROR,
                "video.cut",
                `Output file ${output} already exists`
            );
            reject(new Error(`Output file ${output} already exists`));
            return;
        }

        if (emptyFile) {
            fs.unlinkSync(output);
        }

        const opts: string[] = [];
        opts.push("-i", input);
        opts.push("-ss", start_second.toString());
        opts.push("-t", (end_second - start_second).toString());
        opts.push("-c", "copy");
        // opts.push("-bsf:a", "aac_adtstoasc");
        // ...ffmpeg_options,
        // output,

        if (Config.debug || Config.getInstance().cfg("app_verbose")) {
            opts.push("-loglevel", "repeat+level+verbose");
        }

        opts.push(output);

        log(LOGLEVEL.INFO, "video.cut", `Cutting ${input} to ${output}`);

        const job = startJob(`cut_${path.basename(input)}`, ffmpegPath, opts);

        if (!job || !job.process) {
            reject(
                new Error(
                    `Failed to start job for cutting ${input} to ${output}`
                )
            );
            return;
        }

        job.process.on("error", (err) => {
            log(
                LOGLEVEL.ERROR,
                "video.cut",
                `Process ${process.pid} error: ${err.message}`
            );
            // reject({ code: -1, success: false, stdout: job.stdout, stderr: job.stderr });
            reject(new Error(`Process ${process.pid} error: ${err.message}`));
        });

        job.process.on("close", (code) => {
            if (job) {
                job.clear();
            }
            // const out_log = ffmpeg.stdout.read();
            const success =
                fs.existsSync(output) && fs.statSync(output).size > 0;
            if (success) {
                log(
                    LOGLEVEL.SUCCESS,
                    "video.cut",
                    `Cut ${input} to ${output} success`
                );
                resolve({
                    code: code || -1,
                    success,
                    stdout: job.stdout,
                    stderr: job.stderr,
                });
            } else {
                log(
                    LOGLEVEL.ERROR,
                    "video.cut",
                    `Failed to cut ${path.basename(input)} to ${path.basename(
                        output
                    )}`
                );
                // reject({ code, success, stdout: job.stdout, stderr: job.stderr });

                let message = "Unknown error";
                const errorSearch = job.stderr
                    .join("")
                    .match(/\[error\] (.*)/g);
                if (errorSearch && errorSearch.length > 0) {
                    message = errorSearch.slice(1).join(", ");
                }

                if (fs.existsSync(output) && fs.statSync(output).size == 0) {
                    fs.unlinkSync(output);
                }

                // for (const err of errorSearch) {
                //    message = err[1];
                reject(
                    new Error(
                        `Failed to cut ${path.basename(
                            input
                        )} to ${path.basename(output)}: ${message}`
                    )
                );
            }
        });

        let currentSeconds = 0;
        let totalSeconds = 0;
        job.on("log", (stream: string, data: string) => {
            const totalDurationMatch = data.match(
                /Duration: (\d+):(\d+):(\d+)/
            );
            if (totalDurationMatch && !totalSeconds) {
                totalSeconds =
                    parseInt(totalDurationMatch[1]) * 3600 +
                    parseInt(totalDurationMatch[2]) * 60 +
                    parseInt(totalDurationMatch[3]);
                console.debug(`Cut total duration: ${totalSeconds}`);
            }
            const currentTimeMatch = data.match(/time=(\d+):(\d+):(\d+)/);
            if (currentTimeMatch && totalSeconds > 0) {
                currentSeconds =
                    parseInt(currentTimeMatch[1]) * 3600 +
                    parseInt(currentTimeMatch[2]) * 60 +
                    parseInt(currentTimeMatch[3]);
                job.setProgress(currentSeconds / totalSeconds);
                console.debug(`Cut current time: ${currentSeconds}`);
            }
            if (data.match(/moving the moov atom/)) {
                console.debug("Cut moov atom move");
            }
        });
    });
}

export function validateMediaInfo(info: MediaInfoObject): boolean {
    if (!info.general) {
        throw new Error("Missing general info");
    }

    if (!info.general.Format) {
        throw new Error("Missing general format");
    }

    if (info.general.Format.startsWith("0x0000")) {
        throw new Error("Corrupted general format");
    }

    if (!info.general.Duration) {
        throw new Error("Missing general duration");
    }

    if (!info.general.OverallBitRate) {
        throw new Error("Missing general overall bitrate");
    }

    if (info.video && !info.video.FrameRate) {
        throw new Error("Missing video framerate");
    }

    return true;
}

export function parseMediainfoOutput(inputData: string): MediaInfoObject {
    const json: MediaInfoJSONOutput = JSON.parse(inputData);

    const data: any = {};

    for (const track of json.media.track) {
        if (track["@type"] == "General") {
            data.general = track;
        } else if (track["@type"] == "Video") {
            data.video = track;
        } else if (track["@type"] == "Audio") {
            data.audio = track;
        }
    }

    /*
    const data = json.media.track.reduce((acc, track) => {
        if (track["@type"] == "General") {
            acc.general = track;
        } else if (track["@type"] == "Video") {
            acc.video = track;
        } else if (track["@type"] == "Audio") {
            acc.audio = track;
        }
        return acc;
    });
    */

    try {
        validateMediaInfo(data);
    } catch (error) {
        log(
            LOGLEVEL.ERROR,
            "helper.parseMediainfoOutput",
            `Invalid mediainfo: ${(error as Error).message}`,
            error
        );
        console.error(error);
        console.error(json);
        throw error;
    }

    return data as MediaInfoObject;
}

/**
 * Return mediainfo for a file
 *
 * @param filename
 * @throws
 * @returns
 */
export async function mediainfo(filename: string): Promise<MediaInfoObject> {
    log(LOGLEVEL.INFO, "helper.mediainfo", `Run mediainfo on ${filename}`);

    if (!filename) {
        throw new Error("No filename supplied for mediainfo");
    }

    if (!fs.existsSync(filename)) {
        throw new Error(`File not found for mediainfo: ${filename}`);
    }

    if (fs.statSync(filename).size == 0) {
        throw new Error("Filesize is 0 for mediainfo");
    }

    const mediainfoPath = Helper.path_mediainfo();
    if (!mediainfoPath) throw new Error("Failed to find mediainfo");

    let output;

    try {
        output = await exec(
            mediainfoPath,
            ["--Full", "--Output=JSON", filename],
            {},
            `mediainfo_${path.basename(filename)}`
        );
    } catch (error) {
        log(
            LOGLEVEL.ERROR,
            "helper.mediainfo",
            `Mediainfo of ${filename} returned: ${(error as Error).message}`,
            error
        );
        throw error; // rethrow?
    }

    if (output && output.stdout) {
        return parseMediainfoOutput(output.stdout.join(""));
    } else {
        log(
            LOGLEVEL.ERROR,
            "helper.mediainfo",
            `No output from mediainfo for ${filename}`
        );
        throw new Error("No output from mediainfo");
    }
}

export async function ffprobe(filename: string): Promise<FFProbe> {
    log(LOGLEVEL.INFO, "helper.ffprobe", `Run ffprobe on ${filename}`);

    if (!filename) {
        throw new Error("No filename supplied for ffprobe");
    }

    if (!fs.existsSync(filename)) {
        throw new Error("File not found for ffprobe");
    }

    if (fs.statSync(filename).size == 0) {
        throw new Error("Filesize is 0 for ffprobe");
    }

    const ffprobePath = Helper.path_ffprobe();
    if (!ffprobePath) throw new Error("Failed to find ffprobe");

    const output = await execSimple(
        ffprobePath,
        [
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            // "-show_entries",
            filename,
        ],
        "ffprobe"
    );

    if (output && output.stdout) {
        const json: FFProbe = JSON.parse(output.stdout.join(""));
        return json;
    } else {
        log(
            LOGLEVEL.ERROR,
            "helper.ffprobe",
            `No output from ffprobe for ${filename}`
        );
        throw new Error("No output from ffprobe");
    }
}

function parseFrameRate(rate?: string): number | undefined {
    if (!rate) return undefined;
    const [num, den] = rate.split("/").map((v) => parseFloat(v));
    const fps = den ? num / den : num;
    return fps > 0 && isFinite(fps) ? fps : undefined;
}

/**
 * Scan the timestamps of all video packets in a file, streaming the ffprobe output.
 */
function scanVideoPackets(
    ffprobePath: string,
    input: string,
    frameDuration?: number
): Promise<ReturnType<PacketScanner["result"]>> {
    return new Promise((resolve, reject) => {
        const scanner = new PacketScanner(frameDuration);
        const proc = spawn(ffprobePath, [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time,dts_time,flags",
            "-of",
            "csv=p=0",
            input,
        ]);
        const stderr: string[] = [];
        proc.stderr.on("data", (data: Buffer) => stderr.push(data.toString()));
        const lines = readline.createInterface({ input: proc.stdout });
        lines.on("line", (line) => scanner.addLine(line));
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code !== 0) {
                reject(
                    new Error(
                        `ffprobe packet scan failed (${code}): ${stderr
                            .join("")
                            .slice(0, 500)}`
                    )
                );
                return;
            }
            resolve(scanner.result());
        });
    });
}

/**
 * Remux a capture, filling the stream pauses (ad breaks) with black, silent video
 * so the video length matches the stream and chat/chapters stay in sync.
 *
 * The capture itself is only stream copied, just the short filler unit is encoded.
 * Throws if the capture can't be padded, the caller should fall back to {@link remuxFile}.
 *
 * @param intervals stream pauses in seconds since the stream started
 */
export async function remuxFileWithPadding(
    input: string,
    output: string,
    intervals: PauseInterval[],
    metadata_file?: string
): Promise<RemuxReturn & { plan: PadPlan }> {
    const ffmpegPath = Helper.path_ffmpeg();
    const ffprobePath = Helper.path_ffprobe();
    if (!ffmpegPath) throw new Error("Failed to find ffmpeg");
    if (!ffprobePath || !fs.existsSync(ffprobePath)) {
        throw new Error("Failed to find ffprobe");
    }

    const probe = await ffprobe(input);
    const video = probe.streams.find((s) => s.codec_type == "video");
    const audio = probe.streams.find((s) => s.codec_type == "audio");
    if (!video || video.codec_type != "video" || video.codec_name != "h264") {
        throw new Error("Padding needs an h264 video stream");
    }
    if (!audio || audio.codec_type != "audio" || audio.codec_name != "aac") {
        throw new Error("Padding needs an aac audio stream");
    }

    const fps =
        parseFrameRate(video.r_frame_rate) ||
        parseFrameRate(video.avg_frame_rate);
    const sampleRate = Number(audio.sample_rate);
    if (!fps || !sampleRate || !video.width || !video.height) {
        throw new Error(
            "Could not determine video/audio parameters for padding"
        );
    }

    log(
        LOGLEVEL.INFO,
        "video.remuxPadded",
        `Scanning video timestamps of ${input}`
    );
    progressOutput(`🎞 Scanning ${path.basename(input)} for ad breaks`);

    const scan = await scanVideoPackets(ffprobePath, input, 1 / fps);
    if (!scan) throw new Error("No video packets found");

    const plan = planPadding(scan, intervals);
    for (const message of plan.messages) {
        log(LOGLEVEL.INFO, "video.remuxPadded", message);
    }
    log(
        LOGLEVEL.INFO,
        "video.remuxPadded",
        `Padding plan for ${path.basename(input)}: ${
            plan.matchedPauses
        } pauses at timestamp gaps, ` +
            `${plan.estimatedPauses} estimated, ${plan.collapsedGaps} gaps collapsed, ` +
            `${plan.totalFiller.toFixed(1)}s filler in ${
                plan.parts.length
            } parts`
    );

    if (plan.totalFiller < 1) throw new Error("Nothing to pad");

    // encode one filler unit matching the capture, it's repeated for the whole pause
    const unitFrames = fillerUnitFrames(fps, sampleRate);
    const unitSeconds = unitFrames / fps;
    const workBase = path.join(
        BaseConfigCacheFolder.cache,
        `pad_${path.basename(input, path.extname(input))}`
    );
    const fillerFile = `${workBase}_filler.ts`;
    const listFile = `${workBase}.ffconcat`;

    const profile = (video.profile || "").toLowerCase();
    const x264Profile = profile.includes("baseline")
        ? "baseline"
        : profile == "main"
        ? "main"
        : "high";

    try {
        await execSimple(
            ffmpegPath,
            [
                "-y",
                "-f",
                "lavfi",
                "-i",
                `color=c=black:s=${video.width}x${video.height}:r=${
                    video.r_frame_rate || fps
                }`,
                "-f",
                "lavfi",
                "-i",
                `anullsrc=r=${sampleRate}:cl=${
                    audio.channel_layout ||
                    (audio.channels == 1 ? "mono" : "stereo")
                }`,
                "-frames:v",
                unitFrames.toString(),
                "-t",
                unitSeconds.toFixed(6),
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-profile:v",
                x264Profile,
                "-pix_fmt",
                video.pix_fmt || "yuv420p",
                "-bf",
                "0",
                "-g",
                unitFrames.toString(),
                "-c:a",
                "aac",
                "-ar",
                sampleRate.toString(),
                "-ac",
                (audio.channels || 2).toString(),
                "-f",
                "mpegts",
                fillerFile,
            ],
            "pad filler"
        );

        if (!fs.existsSync(fillerFile) || fs.statSync(fillerFile).size == 0) {
            throw new Error("Failed to encode filler");
        }

        const fillerProbe = await ffprobe(fillerFile);
        const fillerStart = parseFloat(fillerProbe.format.start_time) || 0;

        fs.writeFileSync(
            listFile,
            buildConcatList(plan, input, fillerFile, fillerStart, unitSeconds)
        );

        const result = await remuxFile(listFile, output, false, metadata_file, [
            "-f",
            "concat",
            "-safe",
            "0",
        ]);

        return { ...result, plan };
    } finally {
        for (const file of [fillerFile, listFile]) {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
    }
}

export async function videometadata(
    filename: string,
    force = false
): Promise<VideoMetadata | AudioMetadata> {
    let data: MediaInfoObject | false = false;

    const filenameHash = createHash("md5").update(filename).digest("hex"); // TODO: do we need it to by dynamic?
    const dataPath = path.join(
        BaseConfigCacheFolder.cache,
        "mediainfo",
        `${filenameHash}.json`
    );

    if (fs.existsSync(dataPath) && !force) {
        const rawData = fs.readFileSync(dataPath, { encoding: "utf-8" });

        data = JSON.parse(rawData);

        if (!data) {
            log(
                LOGLEVEL.ERROR,
                "helper.videometadata",
                `Trying to read cached mediainfo of ${filename} returned nothing`
            );
            throw new Error("No cached data from mediainfo");
        }

        log(
            LOGLEVEL.DEBUG,
            "helper.videometadata",
            `Read cached mediainfo of ${filename}`
        );
    } else {
        try {
            data = await mediainfo(filename);
        } catch (error) {
            log(
                LOGLEVEL.ERROR,
                "helper.videometadata",
                `Trying to get mediainfo of ${filename} returned: ${
                    (error as Error).message
                }`,
                error
            );
            throw error; // rethrow?
        }

        if (!data) {
            log(
                LOGLEVEL.ERROR,
                "helper.videometadata",
                `Trying to get mediainfo of ${filename} returned false`
            );
            throw new Error("No data from mediainfo");
        }

        if (!fs.existsSync(path.dirname(dataPath))) {
            fs.mkdirSync(path.dirname(dataPath), { recursive: true });
        }

        fs.writeFileSync(dataPath, JSON.stringify(data));

        log(
            LOGLEVEL.DEBUG,
            "helper.videometadata",
            `Wrote cached mediainfo of ${filename}`
        );
    }

    if (!data.general.Format || !data.general.Duration) {
        log(
            LOGLEVEL.ERROR,
            "helper.videometadata",
            `Invalid mediainfo for ${filename} (missing ${
                !data.general.Format ? "Format" : ""
            } ${!data.general.Duration ? "Duration" : ""})`
        );
        throw new Error("Invalid mediainfo: no format/duration");
    }

    // if (!data.video) {
    //     logAdvanced(LOGLEVEL.ERROR, "helper.videometadata", `Invalid mediainfo for ${filename} (missing video)`);
    //     throw new Error("Invalid mediainfo: no video");
    // }

    if (!data.audio) {
        log(
            LOGLEVEL.ERROR,
            "helper.videometadata",
            `Invalid mediainfo for ${filename} (missing audio)`
        );
        throw new Error("Invalid mediainfo: no audio");
    }

    const isAudio = data.video === undefined;

    if (isAudio) {
        if (data.audio) {
            const audioMetadata: AudioMetadata = {
                type: "audio",

                container: data.general.Format,

                size: parseInt(data.general.FileSize),
                // duration: parseInt(data.general.Duration),
                duration: parseFloat(
                    data.audio.Duration || data.general.Duration
                ),
                full_duration: parseFloat(data.general.Duration),
                bitrate: parseInt(data.general.OverallBitRate),

                audio_codec: data.audio.Format,
                audio_bitrate: parseInt(data.audio.BitRate),
                audio_bitrate_mode: data.audio.BitRate_Mode as "VBR" | "CBR",
                audio_sample_rate: parseInt(data.audio.SamplingRate),
                audio_channels: parseInt(data.audio.Channels),
            };

            log(
                LOGLEVEL.SUCCESS,
                "helper.videometadata",
                `${filename} is an audio file ${audioMetadata.duration} long.`
            );

            return audioMetadata;
        } else {
            throw new Error("Invalid mediainfo: no audio");
        }
    } else {
        if (data.video && data.audio) {
            const videoMetadata: VideoMetadata = {
                type: "video",

                container: data.general.Format,

                size: parseInt(data.general.FileSize),
                // duration: parseInt(data.general.Duration),
                duration: parseInt(
                    data.video.Duration || data.general.Duration
                ),
                full_duration: parseInt(data.general.Duration),
                bitrate: parseInt(data.general.OverallBitRate),

                width: parseInt(data.video.Width),
                height: parseInt(data.video.Height),

                fps: parseInt(data.video.FrameRate), // TODO: check if this is correct, seems to be variable
                fps_mode: data.video.FrameRate_Mode,

                audio_codec: data.audio.Format,
                audio_bitrate: parseInt(data.audio.BitRate),
                audio_bitrate_mode: data.audio.BitRate_Mode,
                audio_sample_rate: parseInt(data.audio.SamplingRate),
                audio_channels: parseInt(data.audio.Channels),

                video_codec: data.video.Format,
                video_bitrate: parseInt(data.video.BitRate),
                video_bitrate_mode: data.video.BitRate_Mode as "VBR" | "CBR",
            };

            log(
                LOGLEVEL.SUCCESS,
                "helper.videometadata",
                `${filename} is a video file ${formatDuration(
                    videoMetadata.duration
                )} long at ${videoMetadata.height}p${videoMetadata.fps}.`
            );

            return videoMetadata;
        } else {
            throw new Error("Invalid mediainfo: no video/audio");
        }
    }
}

export function ffmpeg_time(ms: number): string {
    // format as 00:00:00.000
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor(((ms % 3600000) % 60000) / 1000);
    const milliseconds = Math.floor(((ms % 3600000) % 60000) % 1000);
    return `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${milliseconds
        .toString()
        .padStart(3, "0")}`;
}

export async function videoThumbnail(
    filename: string,
    width: number,
    offset = 5000
): Promise<string> {
    log(
        LOGLEVEL.INFO,
        "helper.videoThumbnail",
        `Requested video thumbnail of ${filename}`
    );

    if (!filename) {
        throw new Error("No filename supplied for thumbnail");
    }

    if (!fs.existsSync(filename)) {
        throw new Error(`File not found for video thumbnail: ${filename}`);
    }

    if (fs.statSync(filename).size == 0) {
        throw new Error(`Filesize is 0 for video thumbnail: ${filename}`);
    }

    const filenameHash = createHash("md5")
        .update(filename + width + offset)
        .digest("hex");

    const outputImage = path.join(
        BaseConfigCacheFolder.public_cache_thumbs,
        `${filenameHash}.${Config.getInstance().cfg<string>(
            "thumbnail_format",
            "jpg"
        )}`
    );

    if (fs.existsSync(outputImage)) {
        log(
            LOGLEVEL.DEBUG,
            "helper.videoThumbnail",
            `Thumbnail already exists for ${filename}, returning cached version`
        );
        return path.basename(outputImage);
    }

    const ffmpegPath = Helper.path_ffmpeg();
    if (!ffmpegPath) throw new Error("Failed to find ffmpeg");

    const output = await execSimple(
        ffmpegPath,
        [
            "-ss",
            ffmpeg_time(offset),
            "-i",
            filename,
            "-vf",
            `thumbnail,scale=${width}:-1`,
            "-frames:v",
            "1",
            outputImage,
        ],
        "ffmpeg video thumbnail"
    );

    if (
        output &&
        fs.existsSync(outputImage) &&
        fs.statSync(outputImage).size > 0
    ) {
        log(
            LOGLEVEL.SUCCESS,
            "helper.videoThumbnail",
            `Created video thumbnail for ${filename}`
        );
        return path.basename(outputImage);
    } else {
        log(
            LOGLEVEL.ERROR,
            "helper.videoThumbnail",
            `Failed to create video thumbnail for ${filename}`
        );
        throw new Error("No output from ffmpeg");
    }
}

export async function videoContactSheet(
    video_filename: string,
    output_image: string,
    { width, grid }: { width?: number; grid?: string } = {}
): Promise<boolean> {
    if (!video_filename) {
        throw new Error("No filename supplied for contact sheet");
    }

    if (!fs.existsSync(video_filename)) {
        throw new Error(
            `File not found for video contact sheet: ${video_filename}`
        );
    }

    if (fs.statSync(video_filename).size == 0) {
        throw new Error(
            `Filesize is 0 for video contact sheet: ${video_filename}`
        );
    }

    if (fs.existsSync(output_image)) {
        log(
            LOGLEVEL.DEBUG,
            "helper.videoContactSheet",
            `Contact sheet already exists for ${video_filename}, returning cached version`
        );
        return true;
    }

    log(
        LOGLEVEL.INFO,
        "helper.videoContactSheet",
        `Requested video contact sheet of ${video_filename} with width ${width} and grid ${grid}, output to ${output_image}`
    );

    const vcsiPath = Helper.path_vcsi();

    if (!vcsiPath) throw new Error("Failed to find vcsi");

    const output = await execSimple(
        vcsiPath,
        [
            video_filename,
            "-t", // show timestamp for each frame
            "-w",
            (width || 1920).toString(),
            "-g",
            grid || "3x5",
            "-o",
            output_image,
        ],
        "vcsi video contact sheet"
    );

    if (
        output &&
        fs.existsSync(output_image) &&
        fs.statSync(output_image).size > 0
    ) {
        log(
            LOGLEVEL.SUCCESS,
            "helper.videoContactSheet",
            `Created video contact sheet for ${video_filename}`
        );
        return true;
    }

    log(
        LOGLEVEL.ERROR,
        "helper.videoContactSheet",
        `Failed to create video contact sheet for ${video_filename}`
    );

    throw new Error("No output from vcsi");
}
