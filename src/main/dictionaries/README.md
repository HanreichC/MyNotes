Hunspell dictionaries in Chromium's .bdic format, from https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries
(the files Chromium would otherwise download from Google). The name carries the version Chromium asks for: a new Electron may
want a newer one, and then the end-to-end test's spelling step fails.

- de-DE-3-0.bdic: igerman98 by Björn Jacke, GPL-2.0 / GPL-3.0 / OASIS distribution license
- en-US-10-2.bdic: SCOWL by Kevin Atkinson and contributors, MIT-like license (http://wordlist.aspell.net/scowl-readme/)
