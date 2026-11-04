# Arch, so what is built and tested here matches the CachyOS host.
FROM docker.io/library/archlinux:base-devel

# gtk3 … alsa-lib: what Electron links against; xorg-server-xvfb: a display for the end-to-end test; ttf-*: real text in screenshots
# libxcrypt-compat: the fpm electron-builder downloads for the pacman package needs libcrypt.so.1
RUN pacman -Syu --noconfirm \
        git nodejs npm \
        gtk3 nss libxss libxtst at-spi2-core alsa-lib libdrm mesa libxkbcommon libxcb \
        xorg-server-xvfb xorg-xauth ttf-dejavu libarchive libxcrypt-compat \
    && pacman -Scc --noconfirm
