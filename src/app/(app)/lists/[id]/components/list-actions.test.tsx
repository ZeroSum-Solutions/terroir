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

  it("uses touch-sized generating copy when touchSized is set", async () => {
    const { container } = await mount({ generatingPdf: true, touchSized: true });

    expect(control(container, "Generating PDF")).toBeDefined();
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

  it("keeps every action at least 44px tall", async () => {
    const { container } = await mount({ isPublished: true, slug: "dinner" });

    container.querySelectorAll<HTMLElement>("button,a").forEach((node) => {
      expect(node.className).toContain("min-h-11");
    });
  });
});
