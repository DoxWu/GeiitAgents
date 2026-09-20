import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PrivateMarkdown } from "../LocalMarkdown";

it("renders Markdown without active HTML, remote images or navigable links", () => {
  const { container } = render(<PrivateMarkdown content={'# Local title\n\n![tracking](https://tracker.example/pixel)\n\n[link](https://outside.example)\n\n<script>alert(1)</script>\n<iframe src="https://outside.example"></iframe>\n\n| A | B |\n|---|---|\n| 1 | 2 |'} />);
  expect(screen.getByRole("heading", { name: "Local title" })).toBeInTheDocument();
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(container.querySelector("img, a, script, iframe")).toBeNull();
});
