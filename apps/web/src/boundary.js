import { Component, createElement } from "react";
import { t } from "./i18n.js";

export const BROKEN_MESSAGE = t("نمایش این پیام ممکن نشد");

// Around each message: a render error in one message shows a line for that
// message instead of unmounting the whole thread.
export class MessageBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("[thread] message render failed", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return createElement("div", { className: "my-3 text-sm text-muted-foreground", role: "alert" }, BROKEN_MESSAGE);
  }
}
