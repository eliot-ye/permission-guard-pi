# bounded-glob-compound-separators

Fix bounded-glob checker to honor compound command separators beyond | (namely ; && || & and newline), so bounded read-only globs inside multi-command fragments are correctly classified as safe.
