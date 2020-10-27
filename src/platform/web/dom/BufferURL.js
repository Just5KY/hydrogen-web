/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/


// WARNING: We have to be very careful about what mime-types we allow into blobs.
//
// This means that the content is rendered using the origin of the script which
// called createObjectURL(), and so if the content contains any scripting then it
// will pose a XSS vulnerability when the browser renders it.  This is particularly
// bad if the user right-clicks the URI and pastes it into a new window or tab,
// as the blob will then execute with access to Element's full JS environment(!)
//
// See https://github.com/matrix-org/matrix-react-sdk/pull/1820#issuecomment-385210647
// for details.
//
// We mitigate this by only allowing mime-types into blobs which we know don't
// contain any scripting, and instantiate all others as application/octet-stream
// regardless of what mime-type the event claimed.  Even if the payload itself
// is some malicious HTML, the fact we instantiate it with a media mimetype or
// application/octet-stream means the browser doesn't try to render it as such.
//
// One interesting edge case is image/svg+xml, which empirically *is* rendered
// correctly if the blob is set to the src attribute of an img tag (for thumbnails)
// *even if the mimetype is application/octet-stream*.  However, empirically JS
// in the SVG isn't executed in this scenario, so we seem to be okay.
//
// Tested on Chrome 65 and Firefox 60
//
// The list below is taken mainly from
// https://developer.mozilla.org/en-US/docs/Web/HTML/Supported_media_formats
// N.B. Matrix doesn't currently specify which mimetypes are valid in given
// events, so we pick the ones which HTML5 browsers should be able to display
//
// For the record, mime-types which must NEVER enter this list below include:
//   text/html, text/xhtml, image/svg, image/svg+xml, image/pdf, and similar.

const ALLOWED_BLOB_MIMETYPES = {
    'image/jpeg': true,
    'image/gif': true,
    'image/png': true,

    'video/mp4': true,
    'video/webm': true,
    'video/ogg': true,

    'audio/mp4': true,
    'audio/webm': true,
    'audio/aac': true,
    'audio/mpeg': true,
    'audio/ogg': true,
    'audio/wave': true,
    'audio/wav': true,
    'audio/x-wav': true,
    'audio/x-pn-wav': true,
    'audio/flac': true,
    'audio/x-flac': true,
};

export class BufferURL {
    constructor(buffer, mimetype) {
        mimetype = mimetype ? mimetype.split(";")[0].trim() : '';
        if (!ALLOWED_BLOB_MIMETYPES[mimetype]) {
            mimetype = 'application/octet-stream';
        }
        const blob = new Blob([buffer], {type: mimetype});
        this.url = URL.createObjectURL(blob);
    }

    dispose() {
        URL.revokeObjectURL(this.url);
        this.url = null;
    }
}
