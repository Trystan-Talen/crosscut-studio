import { Component, type ReactNode } from "react";
import { ErrorPanel } from "../ui";

/** Keep navigation available if a page bundle fails to load after an update. */
export class PageBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ErrorPanel
        error="页面未能加载。已保存的数据仍在本地，重新加载后可继续。"
        retry={() => window.location.reload()}
      />
    ) : (
      this.props.children
    );
  }
}
