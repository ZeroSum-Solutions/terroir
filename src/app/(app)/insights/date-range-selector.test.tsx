import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import DateRangeSelector, {
  formatLocalDate,
  isValidCustomRange,
} from "./date-range-selector";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  params: new URLSearchParams("range=30d&metric=scans"),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => navigation.params,
}));

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("DateRangeSelector", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    navigation.push.mockReset();
    navigation.params = new URLSearchParams("range=30d&metric=scans");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("offers Custom and applies its dates without dropping unrelated params", async () => {
    await act(async () => root.render(<DateRangeSelector />));
    const custom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Custom",
    )!;
    await act(async () => custom.click());

    const from = container.querySelector<HTMLInputElement>("#dr-from")!;
    const to = container.querySelector<HTMLInputElement>("#dr-to")!;
    await act(async () => {
      setInputValue(from, "2026-08-01");
      setInputValue(to, "2026-08-20");
    });
    const apply = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply",
    );
    expect(apply).toBeDefined();
    await act(async () => apply!.click());

    expect(navigation.push).toHaveBeenCalledWith(
      "/insights?range=custom&metric=scans&from=2026-08-01&to=2026-08-20",
      { scroll: false },
    );
  });

  it("shows Custom as selected with its URL-provided date controls", async () => {
    navigation.params = new URLSearchParams(
      "range=custom&from=2026-08-01&to=2026-08-20",
    );

    await act(async () => root.render(<DateRangeSelector />));

    const custom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Custom",
    )!;
    expect(custom.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("#dr-from")).not.toBeNull();
    expect(container.querySelector("#dr-to")).not.toBeNull();
  });

  it("synchronizes the custom editor and drafts with search-param rerenders", async () => {
    await act(async () => root.render(<DateRangeSelector />));
    expect(container.querySelector("#dr-from")).toBeNull();

    navigation.params = new URLSearchParams(
      "range=custom&from=2026-07-01&to=2026-07-15",
    );
    await act(async () => root.render(<DateRangeSelector />));
    expect(container.querySelector<HTMLInputElement>("#dr-from")?.value).toBe(
      "2026-07-01",
    );
    expect(container.querySelector<HTMLInputElement>("#dr-to")?.value).toBe(
      "2026-07-15",
    );

    navigation.params = new URLSearchParams(
      "range=custom&from=2026-08-01&to=2026-08-20",
    );
    await act(async () => root.render(<DateRangeSelector />));
    expect(container.querySelector<HTMLInputElement>("#dr-from")?.value).toBe(
      "2026-08-01",
    );
    expect(container.querySelector<HTMLInputElement>("#dr-to")?.value).toBe(
      "2026-08-20",
    );

    navigation.params = new URLSearchParams("range=90d");
    await act(async () => root.render(<DateRangeSelector />));
    expect(container.querySelector("#dr-from")).toBeNull();
    expect(
      [...container.querySelectorAll('[role="radio"]')].find(
        (radio) => radio.textContent === "90d",
      )?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("falls back to All when the URL range is not allowed", async () => {
    navigation.params = new URLSearchParams("range=unexpected");

    await act(async () => root.render(<DateRangeSelector />));

    expect(
      [...container.querySelectorAll('[role="radio"]')].find(
        (radio) => radio.textContent === "All",
      )?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("closes a locally opened Custom editor when the raw URL range changes to an unsupported value", async () => {
    navigation.params = new URLSearchParams(
      "range=all&from=2026-08-01&to=2026-08-20",
    );
    await act(async () => root.render(<DateRangeSelector />));

    const custom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Custom",
    )!;
    await act(async () => custom.click());
    expect(container.querySelector("#dr-from")).not.toBeNull();

    navigation.params = new URLSearchParams(
      "range=unexpected&from=2026-08-01&to=2026-08-20",
    );
    await act(async () => root.render(<DateRangeSelector />));

    expect(container.querySelector("#dr-from")).toBeNull();
    expect(
      [...container.querySelectorAll('[role="radio"]')].find(
        (radio) => radio.textContent === "All",
      )?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps the custom editor open when Custom is clicked twice", async () => {
    await act(async () => root.render(<DateRangeSelector />));
    const custom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Custom",
    )!;

    await act(async () => custom.click());
    await act(async () => custom.click());

    expect(container.querySelector("#dr-from")).not.toBeNull();
    expect(container.querySelector("#dr-to")).not.toBeNull();
  });

  it("wraps its range radios and gives each one a 44px minimum target", async () => {
    await act(async () => root.render(<DateRangeSelector />));

    const radiogroup = container.querySelector('[role="radiogroup"]')!;
    expect(radiogroup.className).toContain("flex-wrap");
    const radios = container.querySelectorAll('[role="radio"]');
    expect(radios.length).toBeGreaterThan(0);
    radios.forEach((radio) => {
      expect(radio.className).toContain("min-h-11");
    });
  });

  it.each([
    {
      name: "malformed",
      query: "range=custom&from=not-a-date&to=2026-08-20",
    },
    {
      name: "impossible",
      query: "range=custom&from=2026-02-30&to=2026-03-01",
    },
    {
      name: "missing",
      query: "range=custom&to=2026-08-20",
    },
    {
      name: "inverted",
      query: "range=custom&from=2026-08-20&to=2026-08-01",
    },
    {
      name: "future",
      query: "range=custom&from=2026-08-01&to=2099-01-01",
    },
  ])("falls back to All for a $name custom URL", async ({ query }) => {
    navigation.params = new URLSearchParams(query);

    await act(async () => root.render(<DateRangeSelector />));

    expect(container.querySelector("#dr-from")).toBeNull();
    expect(
      [...container.querySelectorAll('[role="radio"]')].find(
        (radio) => radio.textContent === "All",
      )?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("keeps Apply disabled for an invalid local Custom draft", async () => {
    await act(async () => root.render(<DateRangeSelector />));
    const custom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Custom",
    )!;
    await act(async () => custom.click());

    const from = container.querySelector<HTMLInputElement>("#dr-from")!;
    const to = container.querySelector<HTMLInputElement>("#dr-to")!;
    await act(async () => {
      setInputValue(from, "2026-08-20");
      setInputValue(to, "2026-08-01");
    });
    const apply = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply",
    )!;
    expect(apply.disabled).toBe(true);
    await act(async () => apply.click());
    expect(navigation.push).not.toHaveBeenCalled();
  });
});

describe("custom range dates", () => {
  it("formats the local calendar date instead of its UTC date", () => {
    const date = new Date("2026-08-21T06:30:00.000Z");
    vi.spyOn(date, "getFullYear").mockReturnValue(2026);
    vi.spyOn(date, "getMonth").mockReturnValue(7);
    vi.spyOn(date, "getDate").mockReturnValue(20);

    expect(formatLocalDate(date)).toBe("2026-08-20");
  });

  it("accepts only real ordered dates through the local current day", () => {
    expect(
      isValidCustomRange("2026-08-01", "2026-08-20", "2026-08-20"),
    ).toBe(true);
    expect(
      isValidCustomRange("2026-02-30", "2026-03-01", "2026-08-20"),
    ).toBe(false);
    expect(
      isValidCustomRange("2026-08-20", "2026-08-01", "2026-08-20"),
    ).toBe(false);
    expect(
      isValidCustomRange("2026-08-01", "2026-08-21", "2026-08-20"),
    ).toBe(false);
  });
});
