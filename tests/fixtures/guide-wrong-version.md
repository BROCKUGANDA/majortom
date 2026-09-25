# Wrong-version guide — a patch-level Express 4.x note
# A guide for a DIFFERENT release line, used to assert W_VERSION_UNMENTIONED
# (SPEC.md §4.1). The requested major never appears anywhere in the body text
# below, which is exactly the condition the warning exists to catch.

## Removed methods and properties

### res.sendfile()

The res.sendfile() function was deprecated in this release and should be replaced
with the camel-cased res.sendFile() function in a future release.
