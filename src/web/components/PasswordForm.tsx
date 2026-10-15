import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { message, post } from "../api";
import { useWorkspace } from "../context";
import { ErrorPanel } from "../ui";

export function PasswordForm() {
  const { notify, user } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    if (newPassword !== data.get("confirmation")) {
      setError("两次输入的新密码不一致，请重新确认。");
      return;
    }
    if (currentPassword === newPassword) {
      setError("请使用与当前密码不同的新密码。");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await post("/me/password", { currentPassword, newPassword });
      form.reset();
      notify("本地账号密码已更新");
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="panel profile-form password-form"
      onSubmit={(e) => void submit(e)}
    >
      <h2>
        <KeyRound size={20} /> 修改登录密码
      </h2>
      <p className="muted">
        更新这个创作空间的本地账号密码。新密码至少 10 个字符。
      </p>
      <input
        type="text"
        autoComplete="username"
        value={user.email}
        readOnly
        hidden
      />
      <label className="field">
        <span>当前密码</span>
        <input
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          maxLength={200}
        />
      </label>
      <div className="form-two">
        <label className="field">
          <span>新密码</span>
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={200}
          />
        </label>
        <label className="field">
          <span>再次输入新密码</span>
          <input
            name="confirmation"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={200}
          />
        </label>
      </div>
      {error && <ErrorPanel error={error} />}
      <button className="button primary" disabled={busy}>
        {busy ? "正在更新…" : "更新密码"}
      </button>
    </form>
  );
}
