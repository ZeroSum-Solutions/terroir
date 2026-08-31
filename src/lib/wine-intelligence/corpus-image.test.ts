import { describe, expect, it } from "vitest";
import {
  CORPUS_IMAGE_NOTE,
  resolveWineHeroImage,
  weakerImageKind,
} from "./corpus-image";
import type { XWinesImageKind } from "./xwines-profile";

const KINDS: XWinesImageKind[] = ["label", "producer", "representative"];

describe("weakerImageKind", () => {
  it("keeps the weaker of two claims, whichever side it arrives on", () => {
    expect(weakerImageKind("label", "producer")).toBe("producer");
    expect(weakerImageKind("producer", "label")).toBe("producer");
    expect(weakerImageKind("producer", "representative")).toBe("representative");
    expect(weakerImageKind("label", "representative")).toBe("representative");
  });

  it("leaves a claim alone when nothing weakens it", () => {
    for (const kind of KINDS) expect(weakerImageKind(kind, kind)).toBe(kind);
    expect(weakerImageKind("representative", "label")).toBe("representative");
  });

  it("can never turn a match into a stronger claim than either half made", () => {
    // The property that matters: a producer-confidence match over a genuine
    // label photograph must not come out saying "this wine's label".
    for (const ours of KINDS) {
      for (const theirs of KINDS) {
        const combined = weakerImageKind(ours, theirs);
        expect([ours, theirs]).toContain(combined);
        if (ours === "producer" || theirs === "producer") {
          expect(combined).not.toBe("label");
        }
      }
    }
  });
});

describe("resolveWineHeroImage", () => {
  const wine = { producer: "Benjamin Leroux", name: "Vosne-Romanée" };

  it("prefers the tenant's own photograph and says nothing about it", () => {
    const hero = resolveWineHeroImage({
      heroImageUrl: "https://example.test/own.jpg",
      corpusImage: { url: "https://example.test/corpus.jpg", kind: "label" },
      ...wine,
    });
    expect(hero).toEqual({
      src: "https://example.test/own.jpg",
      alt: "Benjamin Leroux Vosne-Romanée",
      note: null,
    });
  });

  it("captions a corpus stand-in with what the picture actually is", () => {
    for (const kind of KINDS) {
      const hero = resolveWineHeroImage({
        heroImageUrl: null,
        corpusImage: { url: "https://example.test/corpus.jpg", kind },
        ...wine,
      })!;
      expect(hero.note).toBe(CORPUS_IMAGE_NOTE[kind]);
      // A screen reader is told the wine's name only over its own label.
      expect(hero.alt).toBe(kind === "label" ? "Benjamin Leroux Vosne-Romanée" : hero.note);
    }
  });

  it("shows nothing when there is nothing to show", () => {
    expect(
      resolveWineHeroImage({ heroImageUrl: null, corpusImage: null, ...wine }),
    ).toBeNull();
  });
});
