import { describe, expect, it } from "vitest";
import { ICON, iconUrlWithRev, spellIconUrl } from "./html";

describe("icon URLs", () => {
  it("point at the app's own icon protocol, not an external host", () => {
    expect(ICON(266)).toBe("http://icon.localhost/champion/266.png");
    expect(spellIconUrl("summoner_flash.png")).toBe("http://icon.localhost/spell/summoner_flash.png");
  });

  it("replaces the revision instead of stacking query strings", () => {
    expect(iconUrlWithRev("http://icon.localhost/champion/1.png", 1)).toBe("http://icon.localhost/champion/1.png?r=1");
    expect(iconUrlWithRev("http://icon.localhost/champion/1.png?r=1", 2)).toBe(
      "http://icon.localhost/champion/1.png?r=2"
    );
  });
});
