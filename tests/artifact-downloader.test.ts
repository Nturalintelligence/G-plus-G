import { describe, expect, it } from "vitest";
import { isUrlSsrfSafe } from "../src/attachments/artifact-downloader.js";

describe("ResponseArtifactDownloader SSRF Security Validation", () => {
  it("allows safe public HTTPS URLs", () => {
    expect(isUrlSsrfSafe("https://chatgpt.com/assets/img.png").safe).toBe(true);
    expect(isUrlSsrfSafe("https://gemini.google.com/download/file123.pdf").safe).toBe(true);
  });

  it("blocks loopback addresses (localhost, 127.0.0.1, ::1)", () => {
    expect(isUrlSsrfSafe("http://localhost:8080/secret").safe).toBe(false);
    expect(isUrlSsrfSafe("http://127.0.0.1/admin").safe).toBe(false);
    expect(isUrlSsrfSafe("http://[::1]/internal").safe).toBe(false);
  });

  it("blocks private IP ranges (10.x, 192.168.x, 172.16.x)", () => {
    expect(isUrlSsrfSafe("http://10.0.0.1/config").safe).toBe(false);
    expect(isUrlSsrfSafe("http://192.168.1.1/router").safe).toBe(false);
    expect(isUrlSsrfSafe("http://172.20.0.1/internal").safe).toBe(false);
    expect(isUrlSsrfSafe("http://169.254.169.254/latest/meta-data").safe).toBe(false);
  });

  it("blocks non-HTTP protocols (file:, data:, javascript:)", () => {
    expect(isUrlSsrfSafe("file:///C:/Windows/system32/cmd.exe").safe).toBe(false);
    expect(isUrlSsrfSafe("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==").safe).toBe(false);
    expect(isUrlSsrfSafe("javascript:alert('xss')").safe).toBe(false);
  });
});
