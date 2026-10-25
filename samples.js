/* Eight short technical articles for the demo vault, written for this project (no outside text).
 * Highlights below are quoted from them so review mode has cards on the first visit. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SubZeroSamples = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SAVED = '2026-10-20';

  const articles = [
    {
      id: 's1', url: '', savedAt: SAVED, tags: ['containers', 'linux'],
      title: 'A container is a process with a restricted view',
      body: [
        'A container is not a small virtual machine. It is an ordinary Linux process that the kernel has been asked to isolate. The host kernel runs it directly, which is why containers start in a fraction of a second and why a hundred of them can share one small computer.',
        '## Two kernel features do the work',
        'Namespaces decide what a process can see. A container gets its own view of the process list, the network interfaces, the mounted filesystems and the hostname, so from inside it looks like a machine of its own. Control groups, usually called cgroups, decide what a process can use. They cap CPU time, memory and disk bandwidth so one noisy container cannot starve the others.',
        '## Images and layers',
        'An image is a stack of read-only layers plus a little metadata, such as the command to run. Starting a container adds one thin writable layer on top. When the container is removed that layer is thrown away, and that is the reason anything you want to keep must live in a volume rather than inside the container.',
        'On macOS and Windows there is no Linux kernel to share, so Docker quietly runs a small Linux virtual machine and starts your containers inside it.'
      ].join('\n\n')
    },
    {
      id: 's2', url: '', savedAt: SAVED, tags: ['docker', 'compose'],
      title: 'Docker Compose in one page',
      body: [
        'A Compose file describes a whole application in one place. Under services you list each container, under volumes the storage that outlives them, and under networks how they talk to each other. One command, docker compose up -d, creates everything that is missing and starts it in the background.',
        '## Things that trip people up',
        'The depends_on setting controls start order, not readiness. A database container can be running long before it accepts connections. Give the database a healthcheck and make the other service wait for the condition service_healthy.',
        'Variables written as ${NAME:-default} are filled from a file called .env that sits next to the Compose file, and the text after the dash is used when the variable is not set. That is how a project can start with no configuration at all and still be tuned later.',
        'The restart policy unless-stopped brings a service back after a reboot but respects a manual stop. Running docker compose down removes the containers and networks and keeps named volumes, so your data survives unless you add the -v flag.'
      ].join('\n\n')
    },
    {
      id: 's3', url: '', savedAt: SAVED, tags: ['dns', 'privacy', 'networking'],
      title: 'How a DNS sinkhole blocks ads and trackers',
      body: [
        'Before a device can load anything from a name like ads.example.com it has to ask a DNS server for the address. A sinkhole is a DNS server that lies on purpose for names on a blocklist. It answers with an address that goes nowhere, such as 0.0.0.0, or with a not-found reply, and the connection dies before a single byte of the advertisement is requested.',
        '## Where it works',
        'Pi-hole is the best known example. You run it on a small always-on computer, then point your router at it so every device on the network asks it first. Because it works at the name level, it covers phones, televisions and game consoles that cannot run a browser extension.',
        '## Where it does not',
        'A sinkhole is a filter, not a firewall. An app that carries its own encrypted resolver can skip it entirely. Ads served from the same name as the content cannot be separated from it, because blocking the name blocks both. Blocklists also need regular updates, and an over-eager list will occasionally break a legitimate site, so keep an easy way to allow a name again.'
      ].join('\n\n')
    },
    {
      id: 's4', url: '', savedAt: SAVED, tags: ['sqlite', 'databases', 'backups'],
      title: 'SQLite is enough for a personal server',
      body: [
        'A personal tool with one user and a few thousand rows does not need a database server. SQLite is a library that stores everything in a single file, and it has no process to configure, patch or forget about.',
        '## Turn on write-ahead logging',
        'In the default journal mode a writer blocks readers. Write-ahead logging, switched on with PRAGMA journal_mode=WAL, lets readers keep reading while one writer commits. There is still only one writer at a time, so set a busy timeout and let a second writer wait its turn rather than fail.',
        '## Back it up the safe way',
        'Copying the file while the program is writing to it can produce a copy that is damaged. Use the backup API, the .backup command in the sqlite3 shell, or VACUUM INTO, all of which produce a consistent snapshot of a live database. Keep the file on a local disk too, because file locking over network shares is unreliable.'
      ].join('\n\n')
    },
    {
      id: 's5', url: '', savedAt: SAVED, tags: ['open-standards', 'bookmarks', 'rss'],
      title: 'Open formats make leaving free',
      body: [
        'Lock-in rarely comes from a contract. It comes from the day you want your data back and the only export is a file nothing else can read. Software that stores your reading in an open format has already answered the question.',
        '## The ones worth knowing',
        'RSS and Atom are feed formats, so a site can be followed without an account. OPML is a small XML file that lists your feed subscriptions, and almost every feed reader can import and export it. The Netscape bookmark file is an HTML page built from DT, A and H3 elements, a format that browsers have exported for decades, and that makes it the common language between bookmark managers.',
        'The test for any service is simple. Can you export everything, in a format a different program opens, without asking permission? If the answer is yes, you can try the service without worrying about the exit.'
      ].join('\n\n')
    },
    {
      id: 's6', url: '', savedAt: SAVED, tags: ['caddy', 'tls', 'tailscale', 'networking'],
      title: 'Reverse proxies, TLS and private networks',
      body: [
        'A reverse proxy is the front door of a home server. It listens on the standard web ports, speaks encrypted HTTPS to the outside, and forwards plain requests to the right container behind it.',
        '## Caddy and certificates',
        'Caddy can obtain and renew a certificate for your domain name by itself using the ACME protocol, which Let\'s Encrypt and other certificate authorities speak. The domain has to point at your machine and ports 80 and 443 have to be reachable from the internet, so this suits a server with a public address.',
        '## When you do not want to open ports',
        'A private network such as Tailscale connects your own devices with encrypted tunnels and no open ports on your router. Your phone and laptop reach the server as if they were on the same network, and nobody else can. For a tool that only you use, that is usually the smaller and safer choice.',
        'Whichever you pick, set an access token on the application as well. A network boundary is one layer, not the whole defence.'
      ].join('\n\n')
    },
    {
      id: 's7', url: '', savedAt: SAVED, tags: ['backups', 'homelab'],
      title: 'Backups you have actually restored',
      body: [
        'A backup you have never restored is a hope, not a backup. The first time you try it should not be the day you need it.',
        '## The 3-2-1 rule',
        'Keep three copies of anything you care about, on two different kinds of storage, with one copy somewhere else entirely. A second folder on the same disk protects against a deleted file and nothing else. A drive in the same room shares your fire and your flood. An encrypted copy in a different place covers the rest.',
        '## Make it boring',
        'Schedule the backup so it does not depend on remembering. Keep several generations, not just the latest, because corruption gets copied faithfully into the newest backup. Once a quarter, restore into an empty folder and open the result. Write the steps down while you do it, because you will not remember them under stress.'
      ].join('\n\n')
    },
    {
      id: 's8', url: '', savedAt: SAVED, tags: ['search', 'algorithms', 'bm25'],
      title: 'Why BM25 ranks better than counting words',
      body: [
        'The simplest search engine counts how often your words appear in each document. It fails in three predictable ways, and BM25 is a scoring formula that fixes each of them.',
        '## Rare words matter more',
        'A word that appears in nearly every document says little about any one of them. BM25 multiplies by an inverse document frequency, so a word found in two documents out of a thousand counts far more than one found in nine hundred.',
        '## Repetition has diminishing returns',
        'A page that says containers forty times is not forty times more relevant than one that says it four times. The term frequency part of the formula saturates, and a constant called k1 sets how quickly. Values between 1.2 and 2 are common.',
        '## Long documents get no free pass',
        'A long document contains more words by chance. A second constant, b, scales the score by document length relative to the average, with 0 meaning no adjustment and 1 meaning full adjustment. The usual choice is 0.75. This vault uses k1 of 1.5 and b of 0.75, counts title words three times and tag words twice, and runs the same code in your browser and on the server.'
      ].join('\n\n')
    }
  ];

  const highlights = [
    { id: 'h1', articleId: 's1', text: 'A container is not a small virtual machine. It is an ordinary Linux process that the kernel has been asked to isolate.', note: 'What is a container, in one sentence' },
    { id: 'h2', articleId: 's4', text: 'Copying the file while the program is writing to it can produce a copy that is damaged.', note: 'Why not just cp the database' },
    { id: 'h3', articleId: 's7', text: 'A backup you have never restored is a hope, not a backup.', note: 'Backup rule' }
  ];

  return { articles: articles, highlights: highlights };
}));
