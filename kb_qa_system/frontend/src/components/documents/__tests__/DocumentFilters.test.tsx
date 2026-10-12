import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { store } = vi.hoisted(() => ({
  store: {
    documentFilters: { status: "", file_type: "", date_from: "", date_to: "" },
    setDocumentFilters: vi.fn(),
  },
}));

vi.mock("@/store/documentStore", () => ({ useDocumentStore: () => store }));

import { DocumentFilters } from "../DocumentFilters";

beforeEach(() => {
  store.documentFilters = { status: "", file_type: "", date_from: "", date_to: "" };
  store.setDocumentFilters.mockReset();
});

it("exposes status, type and date filters and can clear them", () => {
  const { rerender } = render(<DocumentFilters />);
  fireEvent.change(screen.getByLabelText("按状态筛选"), { target: { value: "failed" } });
  fireEvent.change(screen.getByLabelText("按文件类型筛选"), { target: { value: ".pdf" } });
  fireEvent.change(screen.getByLabelText("创建日期起"), { target: { value: "2026-10-01" } });
  expect(store.setDocumentFilters).toHaveBeenNthCalledWith(1, { status: "failed" });
  expect(store.setDocumentFilters).toHaveBeenNthCalledWith(2, { file_type: ".pdf" });
  expect(store.setDocumentFilters).toHaveBeenNthCalledWith(3, { date_from: "2026-10-01" });

  store.documentFilters = { status: "failed", file_type: ".pdf", date_from: "2026-10-01", date_to: "" };
  rerender(<DocumentFilters />);
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(store.setDocumentFilters).toHaveBeenLastCalledWith({ status: "", file_type: "", date_from: "", date_to: "" });
});
