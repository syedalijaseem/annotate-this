# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's
private vulnerability reporting: open the repository's **Security** tab and
choose **Report a vulnerability**.

Include what you found, how to reproduce it (a small document or image that
triggers it is ideal), and the affected package and version. You will get an
acknowledgement within a few days; fixes for confirmed issues are released as
patch versions and credited unless you prefer otherwise.

## Scope

annotate-this parses untrusted documents and images in the browser and Node.
Issues of interest include prototype pollution, denial of service through
crafted documents or masks, XSS through labels or comments, unsafe handling of
image URLs, and supply-chain problems in published packages. See the threat
model in the project's design notes for what the library defends against.
