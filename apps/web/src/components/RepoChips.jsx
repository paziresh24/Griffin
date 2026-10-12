import { useState } from "react";
import { Popover } from "radix-ui";
import { Command } from "cmdk";
import { Check, Folder, FolderGit2, FolderInput, GitBranch, Loader2, Plus, Server } from "lucide-react";
import { toast } from "sonner";
import { api, usePolling } from "../api.js";
import { FOLDER_BUSY, folderSwitchError, folderSwitchLines } from "../folder-switch.js";
import { t } from "../i18n.js";

// The row above the composer: where the chat runs, the repo it works on (picked
// before the first message; then fixed), its own branch and its worktree. Each chip does something:
// the repo opens the picker, branch and worktree copy themselves. Once the chat has its worktree,
// picking another repo moves the chat there after a confirmation (the old tree is set aside whole).

// "Change repo" on a chat that already works in its own worktree.
async function switchFolder(chatId, repo) {
  try {
    const preview = await api(`/api/chats/${chatId}/folder?repo=${encodeURIComponent(repo)}`);
    if (preview.busy) return toast.error(FOLDER_BUSY);
    if (!window.confirm(`${t("این گفتگو به {repo} برود؟", { repo })}\n\n${folderSwitchLines(preview).join("\n")}`)) return;
    await api(`/api/chats/${chatId}/folder`, { method: "POST", body: { repo } });
    toast.success(t("گفتگو به {repo} رفت", { repo }));
  } catch (error) {
    toast.error(folderSwitchError(error));
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Plain HTTP (LAN address): the old path.
    const area = Object.assign(document.createElement("textarea"), { value });
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

const chip = "inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 text-[11px] text-muted-foreground hover:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

function CopyChip({ icon, value, label, title }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={chip}
      title={copied ? t("کپی شد") : title || value}
      onClick={async () => {
        if (!value || !(await copyText(value))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {icon} <span className="ltr truncate">{copied ? t("کپی شد") : label}</span>
    </button>
  );
}

// `group`: { name, onClear } — the owner's group a new chat from a group's "+" goes into (× drops it).
export function RepoChips({ chatId = null, repo: chosen = null, locked = false, branch = null, worktreePath = null, onRepoChange, group = null }) {
  // A new chat with no choice yet starts on the server's default repo (GRIFFIN_DEFAULT_REPO, if set).
  const repos = usePolling("/api/repos", 5 * 60_000);
  const repo = chosen ?? (locked ? "" : repos?.default || "");
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1">
      <span className={chip} title={t("اجرا روی سرور گریفین؛ build و تست در sandbox همان سرور")}>
        <Server /> <span>{t("سرور گریفین")}</span>
      </span>
      {locked && chatId && repo ? (
        <RepoPicker repo={repo} moving onChange={(next) => next && next !== repo && switchFolder(chatId, next)} />
      ) : locked || !onRepoChange ? (
        repo ? <CopyChip icon={<Folder />} value={repo} label={repo} title={t("ریپوی این گفتگو: {repo} (کپی)", { repo })} /> : null
      ) : (
        <RepoPicker repo={repo} onChange={onRepoChange} />
      )}
      {repo && branch ? <CopyChip icon={<GitBranch />} value={branch} label={branch} title={t("کپی نام شاخه: {branch}", { branch })} /> : null}
      {repo ? (
        worktreePath ? (
          <CopyChip icon={<FolderGit2 />} value={worktreePath} label="worktree" title={t("کپی مسیر worktree: {path}", { path: worktreePath })} />
        ) : (
          <span className={chip} title={t("این گفتگو worktree و شاخهٔ جدای خودش را می‌گیرد؛ با اولین پیام ساخته می‌شود")}>
            <FolderGit2 /> <span>worktree</span>
          </span>
        )
      ) : null}
      {group ? (
        <span className={chip} title={t("این گفتگو در این گروه ساخته می‌شود")}>
          <FolderInput /> <span className="truncate" dir="auto">{group.name}</span>
          <button type="button" onClick={group.onClear} className="-me-1 rounded-full px-1 hover:text-foreground" aria-label={t("بیرون از گروه بساز")}>×</button>
        </span>
      ) : null}
    </div>
  );
}

function RepoPicker({ repo, onChange, moving = false }) {
  const [refresh, setRefresh] = useState(0);
  const data = usePolling(`/api/repos?r=${refresh}`, 5 * 60_000);
  const repos = data?.repos || [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cloning, setCloning] = useState(false);
  const pick = (value) => {
    onChange(value);
    setOpen(false);
  };
  // "group/name" typed in the search box can be cloned from GitLab.
  const project = /^[\w.-]+(\/[\w.-]+)+$/.test(query.trim()) ? query.trim() : null;
  const clone = async () => {
    setCloning(true);
    try {
      const result = await api("/api/repos/clone", { method: "POST", body: { project } });
      setRefresh((n) => n + 1);
      toast.success(t("{repo} کلون شد", { repo: result.repo }));
      pick(result.repo);
    } catch (error) {
      toast.error(t("کلون نشد: {error}", { error: error.message }));
    } finally {
      setCloning(false);
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={`${chip} data-[state=open]:text-foreground`} title={moving ? t("ریپوی این گفتگو (انتخاب ریپوی دیگر = بردن گفتگو به آن، بعد از تأیید)") : t("ریپوی این گفتگو")}>
          <Folder /> <span className="ltr truncate">{repo || t("بدون ریپو")}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" side="top" sideOffset={8} className="pop z-50 w-72 overflow-hidden rounded-xl border bg-card text-sm shadow-xl">
          <Command loop className="flex flex-col">
            <Command.Input value={query} onValueChange={setQuery} autoFocus placeholder={t("جستجو، یا group/name برای کلون…")} className="border-b bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground" />
            <Command.List className="scrollbar-thin max-h-72 overflow-y-auto p-1">
              {moving ? null : (
                <Command.Item value="__none" onSelect={() => pick("")} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 data-[selected=true]:bg-muted">
                  <span className="flex-1">{t("بدون ریپو")}</span>
                  {!repo ? <Check className="size-3.5" /> : null}
                </Command.Item>
              )}
              {repos.map((name) => (
                <Command.Item key={name} value={name} onSelect={() => pick(name)} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 data-[selected=true]:bg-muted">
                  <Folder className="size-3.5 text-muted-foreground" />
                  <span className="ltr flex-1 truncate">{name}</span>
                  {repo === name ? <Check className="size-3.5" /> : null}
                </Command.Item>
              ))}
              {project ? (
                <Command.Item value={`__clone ${project}`} disabled={cloning} onSelect={clone} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 data-[selected=true]:bg-muted">
                  {cloning ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  <span className="flex-1">{t("کلون {project} از گیت‌لب").split("{project}").flatMap((part, i) => (i ? [<span key={i} className="ltr">{project}</span>, part] : [part]))}</span>
                </Command.Item>
              ) : null}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
