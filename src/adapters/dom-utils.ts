import type { Locator } from "playwright";

/**
 * Safely fills a web composer (textarea, input, or ProseMirror/contenteditable element)
 * without triggering Playwright's slow character-by-character emulation or timeouts on large texts.
 */
export async function fillComposerSafely(locator: Locator, text: string): Promise<void> {
  if (text.length < 500) {
    try {
      await locator.fill(text, { timeout: 5_000 });
      return;
    } catch {
      // Fallback to JS evaluation below
    }
  }

  const success = await locator
    .evaluate((el, val) => {
      try {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          el.focus();
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }

        if (el.getAttribute("contenteditable") === "true" || (el as HTMLElement).isContentEditable) {
          el.focus();
          while (el.firstChild) {
            el.removeChild(el.firstChild);
          }

          const lines = val.split("\n");
          lines.forEach((line) => {
            const p = document.createElement("p");
            if (line) {
              p.textContent = line;
            } else {
              p.appendChild(document.createElement("br"));
            }
            el.appendChild(p);
          });

          el.dispatchEvent(
            new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: val,
            }),
          );
          el.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: val,
            }),
          );
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      } catch {
        return false;
      }
      return false;
    }, text)
    .catch(() => false);

  if (!success) {
    await locator.fill(text, { timeout: 15_000 });
  }
}
