import { TwitchChat } from "../src/TwitchChat";

const sockets: any[] = [];
jest.mock("ws", () => ({
    WebSocket: jest.fn().mockImplementation(() => {
        const ws = { send: jest.fn(), close: jest.fn() } as any;
        sockets.push(ws);
        return ws;
    }),
}));

describe("TwitchChat reconnect", () => {
    beforeEach(() => {
        sockets.length = 0;
        jest.useFakeTimers();
    });
    afterEach(() => jest.useRealTimers());

    test("keeps dumping after an unexpected disconnect", () => {
        const chat = new TwitchChat("username");
        const stopDump = jest.spyOn(chat, "stopDump").mockImplementation(() => { });
        chat.connect();
        sockets[0].onclose({ code: 1006, reason: "" });
        expect(stopDump).not.toHaveBeenCalled();
        jest.advanceTimersByTime(5000);
        expect(sockets.length).toBe(2);
    });

    test("stops the dump and doesn't reconnect after close()", () => {
        const chat = new TwitchChat("username");
        const stopDump = jest.spyOn(chat, "stopDump").mockImplementation(() => { });
        chat.dumpStream = {} as any;
        chat.connect();
        chat.close();
        sockets[0].onclose({ code: 1000, reason: "" });
        jest.advanceTimersByTime(5000);
        expect(sockets.length).toBe(1);
        expect(stopDump).toHaveBeenCalled();
    });
});
