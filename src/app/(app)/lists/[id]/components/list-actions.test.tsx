import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListActions } from "./list-actions";

describe("ListActions", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  async function mount(props: Partial<React.ComponentProps<typeof ListActions>> = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const onDownloadPdf = vi.fn();
    const onCopyUrl = vi.fn();
    const onPublish = vi.fn();
    await act(async () => {
      root.render(
        <ListActions
          listId="list-1"
          isPublished={false}
          slug={null}
          generatingPdf={false}
          canManage
          onDownloadPdf={onDownloadPdf}
          onCopyUrl={onCopyUrl}
          onPublish={onPublish}
          {...props}
        />,
      );
    });
    return { container, onDownloadPdf, onCopyUrl, onPublish };
  }

  function control(root: ParentNode, name: string) {
    return [...root.querySelectorAll<HTMLElement>("button,a")].find(
      (node) => node.textContent?.trim() === name,
    )!;
  }

  it("wires Download PDF and Publish clicks to their callbacks", async () => {
    const { container, onDownloadPdf, onPublish } = await mount();

    await act(async () => control(container, "Download PDF").click());
    expect(onDownloadPdf).toHaveBeenCalledOnce();

    await act(async () => control(container, "Publish").click());
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it("shows the generating state and disables the download button", async () => {
    const { container } = await mount({ generatingPdf: true });
    const button = control(container, "Generating...");

    expect(button).toBeDefined();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * GLOBAL-01. The mobile instance keeps two actions in the row and puts the
   * rest behind one control: six pills were 592px wide in a 354px row and
   * wrapped onto two lines at 390px (three when Copy URL joins them).
   */
  it("keeps only Preview and Publish in the row when touchSized", async () => {
    const { container } = await mount({ touchSized: true, isPublished: true, slug: "d" });
    const row = container.querySelector<HTMLElement>("[data-list-control-row]")!;
    const inRow = [...row.children].flatMap((child) =>
      child.matches("button,a") ? [child.textContent?.trim()] : [],
    );
    expect(inRow).toEqual(["Preview", "Publish"]);
    expect(row.className ?? "").not.toContain("flex-wrap");
    expect(row.querySelector('[aria-label="More list actions"]')).not.toBeNull();
  });

  it("keeps every demoted action reachable from the overflow menu", async () => {
    const { container, onDownloadPdf, onCopyUrl } = await mount({
      touchSized: true,
      isPublished: true,
      slug: "dinner",
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="More list actions"]',
    )!;
    await act(async () => trigger.click());

    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Download PDF",
      "Toast Export",
      "CSV",
      "Print",
      "Copy URL",
    ]);
    for (const item of items) expect(item.className).toContain("min-h-11");

    await act(async () => items[0].click());
    expect(onDownloadPdf).toHaveBeenCalledOnce();

    await act(async () => trigger.click());
    const copy = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Copy URL",
    )!;
    await act(async () => copy.click());
    expect(onCopyUrl).toHaveBeenCalledOnce();
  });

  it("uses touch-sized generating copy when touchSized is set", async () => {
    const { container } = await mount({ generatingPdf: true, touchSized: true });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="More list actions"]',
    )!;
    await act(async () => trigger.click());
    const item = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent?.trim() === "Generating PDF",
    );
    expect(item).toBeDefined();
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it("only shows Copy URL when the list is published with a slug", async () => {
    const { container: unpublished } = await mount({ isPublished: false, slug: "dinner" });
    expect(
      [...unpublished.querySelectorAll("button")].some(
        (node) => node.textContent?.trim() === "Copy URL",
      ),
    ).toBe(false);

    const { container: published, onCopyUrl } = await mount({
      isPublished: true,
      slug: "dinner",
    });
    const copyButton = control(published, "Copy URL");
    expect(copyButton).toBeDefined();
    await act(async () => copyButton.click());
    expect(onCopyUrl).toHaveBeenCalledOnce();
  });

  /**
   * SD-12 — `POST /api/wine-lists/{id}/publish` is owner/manager only, and
   * Publish was the last control on `/lists/[id]` still offered to a staff
   * member. Every other action here is a GET and stays.
   */
  it("offers a staff member no Publish, on either instance", async () => {
    for (const touchSized of [false, true]) {
      const { container } = await mount({
        canManage: false,
        touchSized,
        isPublished: true,
        slug: "dinner",
      });
      const row = container.querySelector<HTMLElement>("[data-list-control-row]")!;
      expect(
        [...row.querySelectorAll("button,a")].some(
          (node) => node.textContent?.trim() === "Publish",
        ),
        `touchSized=${touchSized}`,
      ).toBe(false);
      // The read-only half is untouched.
      expect(control(container, "Preview")).toBeDefined();
    }
  });

  it("keeps every action at least 44px tall", async () => {
    const { container } = await mount({ isPublished: true, slug: "dinner" });

    container.querySelectorAll<HTMLElement>("button,a").forEach((node) => {
      expect(node.className).toContain("min-h-11");
    });
  });
});
