# Desktop local dependencies

`editingmachine-bounded-sprintf-1.0.0.tgz` is an exact copy of the archive in
the parent workspace's `vendor/`. Its maintained source is
`vendor/bounded-sprintf` in that workspace, based on sprintf-js 1.1.3
(BSD-3-Clause). The archive contains that source and its original LICENSE.
It bounds numeric precision and field width (GHSA-hp3w-g68c-fv3c).

Keep this real archive inside the desktop checkout, not a symlink to the parent.
Both workspace desktop development and standalone releases use
`file:vendor/editingmachine-bounded-sprintf-1.0.0.tgz` plus the `$sprintf-js`
override. Do not replace it with upstream sprintf-js.

When changing the maintained fork, bump its version, repack it, copy the new
archive here, and update all consuming manifests and lockfiles. The desktop
release regression tests compare these archive bytes and the installed source
and license with the maintained fork. The release preflight checks the archive
against the lockfile's SHA-512 integrity before any GitHub mutation.
