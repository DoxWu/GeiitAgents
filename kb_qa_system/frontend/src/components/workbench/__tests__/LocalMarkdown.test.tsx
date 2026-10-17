import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useState } from "react";
import userEvent from '@testing-library/user-event';
import { LocalMarkdown, PrivateMarkdown } from "../LocalMarkdown";
import { useWorkbenchStore } from '@/store/workbenchStore';
import type { LocalDocument } from '@/types/workbench';

afterEach(() => {
  cleanup();
  useWorkbenchStore.setState({ unlocked: false, referenceDocuments: [] });
});

it("renders Markdown without active HTML, remote images or navigable links", () => {
  const { container } = render(<PrivateMarkdown content={'# Local title\n\n![tracking](https://tracker.example/pixel)\n\n[link](https://outside.example)\n\n<script>alert(1)</script>\n<iframe src="https://outside.example"></iframe>\n\n| A | B |\n|---|---|\n| 1 | 2 |'} />);
  expect(screen.getByRole("heading", { name: "Local title" })).toBeInTheDocument();
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(container.querySelector("img, a, script, iframe")).toBeNull();
});

it('reopens a previously saved encrypted reference without selecting its source file again', async () => {
  useWorkbenchStore.setState({ unlocked: true, referenceDocuments: [{ id: 'saved-1', name: 'guide.md', content: '# Saved guide\n\nStored text.', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z' }] });
  function Harness() {
    const [document, setDocument] = useState<LocalDocument | null>(null);
    return <LocalMarkdown document={document} onChange={setDocument} />;
  }
  render(<Harness />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole('combobox', { name: '本机资料库' }), 'saved-1');
  await user.click(screen.getByRole('button', { name: '载入所选材料' }));
  expect(screen.getByRole('heading', { name: 'Saved guide' })).toBeInTheDocument();
});
