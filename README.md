# DeLM 0.3.1 for macOS

Prebuilt native plugins for Codex, Claude Code and Pi on Apple Silicon and Intel. Requires the selected host CLI and Git; no Rust or Python is needed.

**Unsigned review artifact. Not for public distribution or installation.**

Once this signed release is published, install with:

```sh
codex plugin marketplace add aadcha/delm-agent-plugin --ref marketplace && codex plugin add delm@delm
```

Restart Codex, open `/hooks`, and review and trust the DeLM hooks. Restart Codex once more, then invoke `$delm:run <task>`. Installation starts no workers and does not grant hook trust.

Update with `codex plugin marketplace upgrade delm`, review any changed hooks in `/hooks`, and restart before running DeLM. Remove with `codex plugin remove delm@delm`; saved DeLM runs are retained.

For Claude Code:

```sh
claude plugin marketplace add https://github.com/aadcha/delm-agent-plugin.git#marketplace --scope user
claude plugin install delm@delm --scope user
```

Restart Claude Code, then use `/delm:run <task>`. Update with `claude plugin marketplace update delm` followed by `claude plugin update delm@delm --scope user`. Remove with `claude plugin uninstall delm@delm --scope user --keep-data`. Native plugin validation checks packaging, separately from runtime qualification.

For Pi:

```sh
pi install git:github.com/aadcha/delm-agent-plugin@marketplace
```

Start a new Pi session, then use `/delm:run <task>`. Update with `pi update --extension git:github.com/aadcha/delm-agent-plugin@marketplace`. Remove with `pi remove git:github.com/aadcha/delm-agent-plugin@marketplace`; saved DeLM runs are retained.

Claude architectures with matching real native task evidence: none; qualification remains incomplete.

[Source and support](https://github.com/aadcha/delm-agent-plugin) · [Project](https://yuzhenmao.github.io/DeLM/) · [Paper](https://arxiv.org/abs/2606.10662)
