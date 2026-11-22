#!/usr/bin/env bash
# Refuses a push or a CI run whose commits carry internal files, API keys or internal addresses.
# Usage: scripts/leak-check.sh [git rev-list arguments]   (default: HEAD, every commit reachable from it)
set -euo pipefail

[ "$#" -gt 0 ] || set -- HEAD

# Path names that never belong in a public repo.
paths='(^|/)(CLAUDE([.]local)?[.]md|NEXT[.]md|[.]claude|wiki)(/|$)'

# Content: a value after a key prefix, a key in a URL, a private address.
# Matched without regard to case. Each pattern is written so that this file does not match itself.
text='c_(serv|acct)_[A-Za-z0-9]{5,}'
text+='|whsec_[A-Za-z0-9+/=_-]{8,}'
text+='|(api-key|api_key|apiKey)=[A-Za-z0-9_-]{8,}'
text+='|(^|[^0-9.])10[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}([^0-9]|$)'
text+='|(^|[^0-9.])192[.]168[.][0-9]{1,3}[.][0-9]{1,3}([^0-9]|$)'
text+='|(^|[^0-9.])172[.](1[6-9]|2[0-9]|3[01])[.][0-9]{1,3}[.][0-9]{1,3}([^0-9]|$)'
text+='|(^|[^0-9.])100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])[.][0-9]{1,3}[.][0-9]{1,3}([^0-9]|$)'
text+='|(^|[^0-9a-f:])f[cd][0-9a-f]{2}:[0-9a-f]{0,4}:'

# A host under Carbium's domains is refused unless it is one of the public ones.
host='([a-z0-9-]+[.])+carbium[.](sh|io)'
public=' services.carbium.sh dex.carbium.io tokens.carbium.io www.carbium.io docs.carbium.io '

stop() { echo "leak-check: $1" >&2; exit 2; }

# More patterns, one extended regular expression a line, from a file kept outside every repo (when it exists).
# A last line with no newline counts; a pattern that does not compile stops the check, it never passes as clean.
extra=${LEAK_CHECK_EXTRA:-${HOME:-}/.config/carbium/leak-check-extra}
if [ -r "$extra" ]; then
  while IFS= read -r more || [ -n "$more" ]; do [ -z "$more" ] || text+="|$more"; done <"$extra"
  compiles=0
  grep -E -e "$text" </dev/null >/dev/null 2>&1 || compiles=$?
  [ "$compiles" -le 1 ] || stop "a pattern in $extra does not compile"
fi
commits=$(git rev-list "$@") || stop "cannot list the commits to check"
objects=$(git rev-list --objects "$@") || stop "cannot list the objects to check"
tmp=$(mktemp) || stop "cannot make a temporary file"
trap 'rm -f "$tmp"' EXIT

bad=0
refuse() { echo "leak-check: $1"; bad=1; }
# Line numbers of the matches only: a matched value is never printed.
hits() {
  tr -d '\000' >"$tmp"
  {
    grep -a -i -n -E -e "$text" "$tmp" | cut -d: -f1
    grep -a -i -n -o -E -e "$host" "$tmp" | tr '[:upper:]' '[:lower:]' | while IFS=: read -r line name; do
      case $public in *" $name "*) ;; *) echo "$line" ;; esac
    done
  } | sort -n -u | tr '\n' ' ' || true
}

# Path names, commit by commit: a file whose content is already known under another name is still listed.
for commit in $commits; do
  names=$(git ls-tree -r -t -z --name-only "$commit" | tr '\0' '\n')
  while IFS= read -r name; do
    [ -n "$name" ] && refuse "internal path: $name"
  done < <(printf '%s\n' "$names" | grep -a -i -E -e "$paths" || true)
  if [ -n "$(printf '%s\n' "$names" | hits)" ]; then
    refuse "commit ${commit:0:12}: a path name carries a key or an internal address"
  fi
  if [ -n "$(git show -s --format='%an %ae %cn %ce%n%B' "$commit" | hits)" ]; then
    refuse "commit ${commit:0:12}: its message or author line carries a key or an internal address"
  fi
done

# The content of every file version in those commits.
while read -r sha path; do
  [ -n "$path" ] && [ "$(git cat-file -t "$sha")" = blob ] || continue
  lines=$(git cat-file blob "$sha" | hits)
  [ -z "$lines" ] || refuse "$path: line $lines"
done <<<"$objects"

# The message of an annotated tag given as an argument.
for arg in "$@"; do
  [ "$(git cat-file -t "$arg" 2>/dev/null || true)" = tag ] || continue
  [ -z "$(git cat-file tag "$arg" | hits)" ] || refuse "tag ${arg:0:12}: its message carries a key or an internal address"
done

[ "$bad" -eq 0 ] && echo "leak-check: clean"
exit "$bad"
