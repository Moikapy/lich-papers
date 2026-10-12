import { describe, expect, it } from "vitest";
import { ARXIV_DEFAULT_LICENSE, isOpenLicense, licenseLabel, parseOaiLicense } from "../src/worker/arxiv";

describe("parseOaiLicense", () => {
  it("reads the license URI from an arXiv-format OAI-PMH record", () => {
    const xml = `<OAI-PMH><GetRecord><record><metadata><arXiv xmlns="http://arxiv.org/OAI/arXiv/">
      <id>1410.6579</id><license>http://creativecommons.org/licenses/publicdomain/</license>
    </arXiv></metadata></record></GetRecord></OAI-PMH>`;
    expect(parseOaiLicense(xml)).toBe("http://creativecommons.org/licenses/publicdomain/");
  });
  it("returns null when the record has no license element", () => {
    expect(parseOaiLicense("<OAI-PMH><arXiv><id>x</id></arXiv></OAI-PMH>")).toBeNull();
  });
});

describe("isOpenLicense", () => {
  it.each([
    ["http://creativecommons.org/licenses/by/4.0/", true],
    ["http://creativecommons.org/licenses/by-sa/4.0/", true],
    ["http://creativecommons.org/publicdomain/zero/1.0/", true],
    ["http://creativecommons.org/licenses/publicdomain/", true],
    ["http://creativecommons.org/licenses/by-nc-sa/4.0/", false],
    ["http://creativecommons.org/licenses/by-nc-nd/4.0/", false],
    ["http://creativecommons.org/licenses/by-nd/4.0/", false],
    [ARXIV_DEFAULT_LICENSE, false],
    [null, false],
  ])("%s -> %s", (uri, open) => expect(isOpenLicense(uri)).toBe(open));
});

describe("licenseLabel", () => {
  it("names licenses for display", () => {
    expect(licenseLabel("http://creativecommons.org/licenses/by/4.0/")).toBe("CC BY 4.0");
    expect(licenseLabel("http://creativecommons.org/licenses/by-nc-nd/4.0/")).toBe("CC BY-NC-ND 4.0");
    expect(licenseLabel("http://creativecommons.org/publicdomain/zero/1.0/")).toBe("CC0 1.0 (public domain)");
    expect(licenseLabel(ARXIV_DEFAULT_LICENSE)).toMatch(/arXiv license/);
    expect(licenseLabel(null)).toMatch(/arXiv license/);
  });
});
