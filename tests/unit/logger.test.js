import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, logger } from "../../open-sse/utils/logger.js";

describe("logger module", () => {
  let stdoutWrite;
  let stderrWrite;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLogLevel !== undefined) {
      process.env.LOG_LEVEL = originalLogLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
  });

  describe("createLogger factory and singleton export", () => {
    it("exports createLogger function and logger singleton", () => {
      expect(typeof createLogger).toBe("function");
      expect(logger).toBeDefined();
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
    });

    it("createLogger returns a new logger instance", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();
      expect(typeof log.debug).toBe("function");
      expect(typeof log.info).toBe("function");
      expect(typeof log.warn).toBe("function");
      expect(typeof log.error).toBe("function");
    });
  });

  describe("output format", () => {
    it("formats output as [ISO-8601] [LEVEL:tag] message", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      log.info("REQUEST", "upstream dispatched");

      expect(stdoutWrite).toHaveBeenCalledTimes(1);
      const output = stdoutWrite.mock.calls[0][0];
      // Match pattern: [2024-01-15T09:30:00.123Z] [INFO:REQUEST] upstream dispatched\n
      expect(output).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO:REQUEST\] upstream dispatched\n$/);
    });

    it("uses uppercase level names in output", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      log.debug("T", "msg");
      log.warn("T", "msg");
      log.error("T", "msg");

      expect(stdoutWrite.mock.calls[0][0]).toContain("[DEBUG:T]");
      expect(stderrWrite.mock.calls[0][0]).toContain("[WARN:T]");
      expect(stderrWrite.mock.calls[1][0]).toContain("[ERROR:T]");
    });

    it("ends each line with a newline", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      log.info("T", "hello");
      expect(stdoutWrite.mock.calls[0][0].endsWith("\n")).toBe(true);
    });
  });

  describe("stream routing", () => {
    it("routes debug and info to stdout", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      log.debug("TAG", "debug message");
      log.info("TAG", "info message");

      expect(stdoutWrite).toHaveBeenCalledTimes(2);
      expect(stderrWrite).not.toHaveBeenCalled();
    });

    it("routes warn and error to stderr", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      log.warn("TAG", "warn message");
      log.error("TAG", "error message");

      expect(stderrWrite).toHaveBeenCalledTimes(2);
      expect(stdoutWrite).not.toHaveBeenCalled();
    });
  });

  describe("level filtering", () => {
    it("suppresses messages below configured level (info)", () => {
      process.env.LOG_LEVEL = "info";
      const log = createLogger();

      log.debug("T", "should be suppressed");
      log.info("T", "should appear");
      log.warn("T", "should appear");
      log.error("T", "should appear");

      expect(stdoutWrite).toHaveBeenCalledTimes(1); // only info
      expect(stderrWrite).toHaveBeenCalledTimes(2); // warn + error
    });

    it("suppresses messages below configured level (warn)", () => {
      process.env.LOG_LEVEL = "WARN";
      const log = createLogger();

      log.debug("T", "no");
      log.info("T", "no");
      log.warn("T", "yes");
      log.error("T", "yes");

      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledTimes(2);
    });

    it("shows all at debug level", () => {
      process.env.LOG_LEVEL = "DEBUG";
      const log = createLogger();

      log.debug("T", "yes");
      log.info("T", "yes");
      log.warn("T", "yes");
      log.error("T", "yes");

      expect(stdoutWrite).toHaveBeenCalledTimes(2);
      expect(stderrWrite).toHaveBeenCalledTimes(2);
    });

    it("only shows error at error level", () => {
      process.env.LOG_LEVEL = "error";
      const log = createLogger();

      log.debug("T", "no");
      log.info("T", "no");
      log.warn("T", "no");
      log.error("T", "yes");

      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledTimes(1);
    });

    it("defaults to info for unrecognized values", () => {
      process.env.LOG_LEVEL = "banana";
      const log = createLogger();

      log.debug("T", "suppressed");
      log.info("T", "visible");

      expect(stdoutWrite).toHaveBeenCalledTimes(1);
    });

    it("defaults to info when LOG_LEVEL is not set", () => {
      delete process.env.LOG_LEVEL;
      const log = createLogger();

      log.debug("T", "suppressed");
      log.info("T", "visible");

      expect(stdoutWrite).toHaveBeenCalledTimes(1);
    });

    it("handles case-insensitive LOG_LEVEL", () => {
      process.env.LOG_LEVEL = "Error";
      const log = createLogger();

      log.warn("T", "suppressed");
      log.error("T", "visible");

      expect(stderrWrite).toHaveBeenCalledTimes(1);
      expect(stderrWrite.mock.calls[0][0]).toContain("[ERROR:T]");
    });
  });

  describe("truncation", () => {
    it("truncates tag to 32 characters", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      const longTag = "A".repeat(100);
      log.info(longTag, "msg");

      const output = stdoutWrite.mock.calls[0][0];
      const truncatedTag = "A".repeat(32);
      expect(output).toContain(`[INFO:${truncatedTag}]`);
      expect(output).not.toContain("A".repeat(33));
    });

    it("truncates message to 4096 characters", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      const longMsg = "B".repeat(5000);
      log.info("TAG", longMsg);

      const output = stdoutWrite.mock.calls[0][0];
      // The message portion should be exactly 4096 chars
      expect(output).toContain("B".repeat(4096));
      expect(output).not.toContain("B".repeat(4097));
    });

    it("preserves short tags and messages intact", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      log.info("MY_TAG", "hello world");
      const output = stdoutWrite.mock.calls[0][0];
      expect(output).toContain("[INFO:MY_TAG] hello world");
    });
  });

  describe("error safety", () => {
    it("does not throw when stdout.write throws", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      stdoutWrite.mockImplementation(() => { throw new Error("write failed"); });

      expect(() => log.info("T", "msg")).not.toThrow();
    });

    it("does not throw when stderr.write throws", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      stderrWrite.mockImplementation(() => { throw new Error("write failed"); });

      expect(() => log.error("T", "msg")).not.toThrow();
    });

    it("does not throw for null/undefined tag or message", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      expect(() => log.info(null, "msg")).not.toThrow();
      expect(() => log.info("T", undefined)).not.toThrow();
      expect(() => log.info(undefined, null)).not.toThrow();
    });

    it("does not throw for numeric inputs", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      expect(() => log.info(123, 456)).not.toThrow();
      const output = stdoutWrite.mock.calls[0][0];
      expect(output).toContain("[INFO:123]");
      expect(output).toContain("456");
    });

    it("does not emit partial output when write throws", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      // First call succeeds, second call throws
      let callCount = 0;
      stdoutWrite.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error("broken pipe");
        return true;
      });

      log.info("T", "msg1");
      // Should have attempted one write that threw
      expect(stdoutWrite).toHaveBeenCalledTimes(1);
    });
  });
});
