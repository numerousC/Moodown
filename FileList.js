"use strict";

(function(){

const iconTypes = new Map([
	[/\/f\/pdf-24$/, 'pdf'],
	[/\/f\/document-24$/, 'doc'],
	[/\/f\/powerpoint-24$/, 'slides'],
	[/\/f\/spreadsheet-24$/, 'spreadsheet'],
	[/\/f\/calc-24$/, 'calc'],
]);

const extensionTypes = new Map([
	['pdf', 'pdf'],
	['doc', 'doc'],
	['ppt', 'slides'],
	['pptx', 'slides'],
	['xls', 'spreadsheet'],
	['xlsx', 'spreadsheet'],
	['zip', 'archive'],
	['7z', 'archive'],
	['rar', 'archive'],
	['gz', 'archive'],
]);

function getFiletypeByIcon(icon) {
	for (let [iconPattern, filetype] of iconTypes) {
		if (iconPattern.test(icon)) {
			return filetype;
		}
	}
	return 'unknown';
}

function getFiletypeByExtension(extension) {
	if (extensionTypes.has(extension)) {
		return extensionTypes.get(extension);
	} else {
		return 'unknown';
	}
}

function safeFilename(filename) {
	return filename
		.replace(/\s+/g, ' ')
		.replace(/[^\sa-zA-Z0-9_\-\.\(\)\[\]\{\},\u4e00-\u9fa5]+/g, '_');
}

function chromeDownload(url, path) {
	return new Promise((resolve, reject) => {
		let filename = url.slice(url.lastIndexOf('/') + 1);
		if (filename.indexOf('?') !== -1) {
			filename = filename.slice(0, filename.indexOf('?'));
		}
		filename = decodeURIComponent(filename);
		chrome.downloads.download({
			url,
			filename: path + filename,
		}, (downloadId) => {
			if (downloadId) {
				resolve(downloadId);
			} else {
				reject();
			}
		});
	});
}

Vue.nextTickPromise = function() {
	return new Promise((resolve, reject) => {
		Vue.nextTick(resolve);
	});
}

Vue.component('file-list', {
	template: '#file-list',
	props: {
		node: Object,
	},
	data() {
		return {
			checked: false,
			expanded: this.node.type === 'root',
			selectedFiles: 0,
			shownFiles: 0,
			unfetchedDirs: 0,
		};
	},
	methods: {
		addSelectedFiles(n) {
			this.selectedFiles += n;
			if (this.$parent !== this.$root) {
				return this.$parent.addSelectedFiles(n);
			}
		},
		addShownFiles(n) {
			this.shownFiles += n;
			if (this.$parent !== this.$root) {
				return this.$parent.addShownFiles(n);
			}
		},
		addUnfetchedDirs(n) {
			this.unfetchedDirs += n;
			if (this.$parent !== this.$root) {
				return this.$parent.addUnfetchedDirs(n);
			}
		},
		updateShownFiles() {
			const shownFiles = this.$root.pattern.test(this.node.name) ? 1 : 0;
			if (this.checked) {
				this.$root.addFiles(this.node.filetype, shownFiles - this.shownFiles);
				this.addSelectedFiles(shownFiles - this.shownFiles);
			}
			this.addShownFiles(shownFiles - this.shownFiles);
		},
		updateChecked() {
			this.checked = this.selectedFiles === this.shownFiles;
			if (this.$parent.node.type !== 'root') {
				return this.$parent.updateChecked();
			}
		},
		onCheck: co.wrap(function*() {
			yield this.setCheck(this.checked);
			if (this.$parent.node.type !== 'root') {
				this.$parent.updateChecked();
			}
		}),
		setCheck: co.wrap(function*(checked) {
			if (this.node.type === 'file') {
				this.addSelectedFiles(checked ? 1 : -1);
				this.$root.addFiles(this.node.filetype, checked ? 1 : -1);
			} else {
				if (!this.node.fetched) {
					yield this.fetch();
				}
				yield Vue.nextTickPromise();
				for (const child of this.$children) {
					if (child.unfetchedDirs || child.shownFiles && child.checked !== checked) {
						child.checked = checked;
						yield child.setCheck(checked, false);
					}
				}
			}
		}),
		fetch: co.wrap(function*() {
			this.$root.startLoading();
			const children = [];
			const resp = yield fetch(`http://moodle.nottingham.ac.uk/mod/folder/view.php?id=${this.node.id}`, { credentials: 'include' });
			const html = yield resp.text();
			const main = html.match(/<section id="region-main"[\s\S]*?<\/section>/)[0];
			const name = main.match('<h2>(.*?)</h2>')[1];
			const regexFile = /<a href="(http:\/\/moodle.nottingham.ac.uk\/pluginfile.php.*?)">[\s\S]*?<img.*?src="(.*?)" \/>[\s\S]*?<span class="fp-filename">(.*?)<\/span>/g;
			let match;
			while (match = regexFile.exec(main)) {
				children.push({
					type: 'file',
					url: match[1],
					icon: match[2],
					name: match[3],
					filetype: getFiletypeByIcon(match[2]) || 'unknown',
				});
			}
			this.node.fetched = true;
			this.node.children = children;
			this.addUnfetchedDirs(-1);
			this.$root.stopLoading();
		}),
		download: co.wrap(function*(path) {
			if (!this.selectedFiles) {
				return;
			}
			if (this.node.type === 'file') {
				if (!this.node.url) {
					yield this.getUrl();
				}
				yield chromeDownload(this.node.url, path);
				this.$root.addDownloaded(1);
			} else {
				for (const child of this.$children) {
					yield child.download(`${path || ''}${safeFilename(this.node.name)}/`);
				}
			}
		}),
		getUrl: co.wrap(function*() {
			const url = `http://moodle.nottingham.ac.uk/mod/resource/view.php?id=${this.node.id}`;
			const resp = yield fetch(url, {
				method: 'HEAD',
				credentials: 'include',
			});
			if (resp.url.startsWith('http://moodle.nottingham.ac.uk/pluginfile.php')) {
				this.node.url = resp.url;
			} else if (resp.url === url) {
				const resp = yield fetch(url, { credentials: 'include' });
				const text = yield resp.text();
				const match = text.match(/<div class="resourceworkaround">Click <a href="(.*?)"/);
				if (match) {
					this.node.url = match[1];
				} else {
					throw Error('Unknown page content');
				}
			} else {
				throw Error('Unknown redirection');
			}
		}),
	},
	created() {
		if (this.node.type === 'file') {
			this.updateShownFiles();
			this.$root.$watch('pattern', () => {
				this.updateShownFiles();
			});
		} else if (this.node.type === 'dir') {
			if (!this.node.fetched) {
				this.addUnfetchedDirs(1);
			}
		}
	},
	watch: {
		expanded() {
			if (!this.node.fetched) {
				return this.fetch();
			} else {
				return Promise.resolve();
			}
		},
	},
});

})();