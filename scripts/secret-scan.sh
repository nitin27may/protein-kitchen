#!/bin/sh
# Blocks a commit that would add a secret. Used by .githooks/pre-commit.
# Checks only what is staged. Prints file names and rule names, never the secret itself.
# For a deeper scan install gitleaks (brew install gitleaks); it runs too when present.
set -u
root=$(git rev-parse --show-toplevel) || exit 1
cd "$root" || exit 1
fail=0

# 1. Files that must never be committed.
bad=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '(^|/)\.env($|\.[^e]|\.local|\.production)|\.db($|-wal$|-shm$|-journal$)|^backups/|^uploads/|\.age$|(^|/)\.neon$' || true)
if [ -n "$bad" ]; then
  echo "secret-scan: these files must not be committed:"; echo "$bad" | sed 's/^/  /'; fail=1
fi

# 2. Secret-shaped strings in added lines.
added=$(git diff --cached -U0 --diff-filter=ACMR | grep -E '^\+[^+]' || true)
check() { # name, regex
  if printf '%s\n' "$added" | grep -Eq -e "$2"; then echo "secret-scan: looks like a $1 in the staged changes"; fail=1; fi
}
check "GitHub token"            'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'
check "AWS access key id"       'AKIA[0-9A-Z]{16}'
check "private key block"       '-----BEGIN [A-Z ]*PRIVATE KEY-----'
check "database URL with password" 'postgres(ql)?://[^[:space:]"'"'"':@/]+:[^[:space:]"'"'"'@/]+@'
check "Stripe or Anthropic key" 'sk_live_[A-Za-z0-9]{10,}|sk-ant-[A-Za-z0-9_-]{20,}'
check "Slack token"             'xox[baprs]-[A-Za-z0-9-]{10,}'

# 3. Any value from your own .env.local appearing in staged changes (values of 16+ characters; shorter ones such as a region name or "production" are not secrets).
if [ -f .env.local ]; then
  while IFS='=' read -r key val; do
    case "$key" in ''|'#'*) continue;; esac
    val=${val#\"}; val=${val%\"}
    [ ${#val} -lt 16 ] && continue
    if printf '%s\n' "$added" | grep -Fq -e "$val"; then echo "secret-scan: the value of $key from .env.local is in the staged changes"; fail=1; fi
  done < .env.local
fi

# 4. gitleaks, when installed.
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --pre-commit --staged --no-banner --redact >/dev/null 2>&1 || { echo "secret-scan: gitleaks found something; run: gitleaks git --pre-commit --staged --redact"; fail=1; }
fi

[ "$fail" -eq 0 ] || { echo "secret-scan: commit blocked. Remove the secret (and rotate it if it was real)."; exit 1; }
exit 0
