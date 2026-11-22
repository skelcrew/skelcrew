# Running on a server

Skelcrew can run on a server of yours instead of your laptop. Your agents then keep working while your laptop sleeps.

All you need is a server you can reach with `ssh`, running macOS or Linux.

## Set it up

Run this on your laptop:

```sh
sc --remote simon@workbox install
```

Use your own host where this says `simon@workbox`.

It sends your settings, your plugins and your agents' sign-in to the server. If Skelcrew isn't there yet, it asks, then puts it there. Then it runs `sc install` on the server, in your terminal.

Each plugin's sign-in runs once on the server, such as GitHub's. On a server, the GitHub plugin prints its links instead of opening a browser. Open them on your laptop.

The install sets the server up, and starts nothing. Skelcrew starts there the first time you run `sc --remote simon@workbox`, as the next step does. It runs as a background service of your own user, and keeps running after you log out and after a reboot.

## Use it

Run `sc` with `--remote` from a checkout on your laptop:

```sh
cd ~/code/app
sc --remote simon@workbox
```

The server's screen opens, on the same repository. Everything works as it does on your laptop.

Any command works the same way:

```sh
sc --remote simon@workbox ps
sc --remote simon@workbox show APP-12
sc --remote simon@workbox --list
```

What runs stays on the server: the tasks, their clones and their agents. Nothing comes back to your laptop.

## A few differences

- Enter on a pull request copies its link to your clipboard, rather than opening it.
- A file you drop onto the screen is copied from your laptop to the agent on the server.

## Keeping it up to date

When you change your settings or plugins, send them again:

```sh
sc --remote simon@workbox install
```

If you forget, Skelcrew reminds you:

```
Your lock on simon@workbox differs from your laptop's. To send yours there, run on your laptop:
  sc --remote simon@workbox install
```

When the server's Skelcrew differs from your laptop's, it asks before going on:

```
Skelcrew on simon@workbox is from abc1234, yours is def5678.
Update it? [Y/n]
```

Yes updates it there. Your agents keep running.

## A server that isn't set up

If you run `sc --remote` on a server that isn't set up yet, it asks:

```
simon@workbox isn't set up. Set it up now? [Y/n]
```

Yes runs the install, then goes on.
