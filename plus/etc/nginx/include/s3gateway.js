/*
 *  Copyright 2020 F5 Networks
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

_require_env_var('S3_ACCESS_KEY_ID');
_require_env_var('S3_SECRET_KEY');
_require_env_var('S3_BUCKET_NAME');
_require_env_var('S3_SERVER');
_require_env_var('S3_SERVER_PROTO');
_require_env_var('S3_SERVER_PORT');
_require_env_var('S3_REGION');
_require_env_var('AWS_SIGS_VERSION');
_require_env_var('S3_STYLE');

var mod_hmac = require('crypto');

/**
 * Flag indicating debug mode operation. If true, additional information
 * about signature generation will be logged.
 * @type {boolean}
 */
var debug = _parseBoolean(process.env['S3_DEBUG']);
var allow_listing = _parseBoolean(process.env['ALLOW_DIRECTORY_LIST'])

var s3_style = process.env['S3_STYLE'];

/**
 * The current moment as a timestamp. This timestamp will be used across
 * functions in order for there to be no variations in signatures.
 * @type {Date}
 */
var now = new Date();

/**
 * Constant defining the service requests are being signed for.
 * @type {string}
 */
var service = 's3';

/**
 * Constant checksum for an empty HTTP body.
 * @type {string}
 */
var emptyPayloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Constant defining the headers being signed.
 * @type {string}
 */
var signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

/**
 * Transform the headers returned from S3 such that there isn't information
 * leakage about S3 and do other tasks needed for appropriate gateway output.
 * @param r HTTP request
 */
function editAmzHeaders(r) {
    var isDirectoryHeadRequest =
        allow_listing &&
        r.method === 'HEAD' &&
        _isDirectory(r.variables.uri_path);

    /* Strips all x-amz- headers from the output HTTP headers so that the
     * requesters to the gateway will not know you are proxying S3. */
    if ('headersOut' in r) {
        for (var key in r.headersOut) {
            /* We delete all headers when it is a directory head request because
             * none of the information is relevant for passing on via a gateway. */
            if (isDirectoryHeadRequest) {
                delete r.headersOut[key];
            } else if (key.toLowerCase().indexOf("x-amz-", 0) >= 0) {
                delete r.headersOut[key];
            }
        }

        /* Transform content type returned on HEAD requests for directories
         * if directory listing is enabled. If you change the output format
         * for the XSL stylesheet from HTML to something else, you will
         * want to change the content type below. */
        if (isDirectoryHeadRequest) {
            r.headersOut['Content-Type'] = 'text/html; charset=utf-8'
        }
    }
}

/**
 * Outputs the timestamp used to sign the request, so that it can be added to
 * the 'Date' header and sent by NGINX.
 *
 * @param r {Request} HTTP request object (not used, but required for NGINX configuration)
 * @returns {string} RFC2616 timestamp
 */
function s3date(r) {
    return now.toUTCString();
}

/**
 * Outputs the timestamp used to sign the request, so that it can be added to
 * the 'x-amz-date' header and sent by NGINX. The output format is
 * ISO 8601: YYYYMMDD'T'HHMMSS'Z'.
 * @see {@link https://docs.aws.amazon.com/general/latest/gr/sigv4-date-handling.html | Handling dates in Signature Version 4}
 *
 * @param r {Request} HTTP request object (not used, but required for NGINX configuration)
 * @returns {string} ISO 8601 timestamp
 */
function awsHeaderDate(r) {
    return _amzDatetime(now, _eightDigitDate(now));
}

/**
 * Creates an AWS authentication signature based on the global settings and
 * the passed request parameter.
 *
 * @param r HTTP request
 * @returns {string} AWS authentication signature
 */
function s3auth(r) {
    var accessId = process.env['S3_ACCESS_KEY_ID'];
    var secret = process.env['S3_SECRET_KEY'];
    var bucket = process.env['S3_BUCKET_NAME'];
    var region = process.env['S3_REGION'];
    var server;
    if (s3_style === 'path') {
	    server = process.env['S3_SERVER'] + ':' + process.env['S3_SERVER_PORT'];
    } else {
        server = process.env['S3_SERVER'];
    }
    var sigver = process.env['AWS_SIGS_VERSION'];

    var signature;

    if (sigver == '2') {
        signature = signatureV2(r, bucket, accessId, secret);
    } else {
        signature = signatureV4(r, now, bucket, accessId, secret, region, server);
    }

    return signature;
}

function s3BaseUri(r) {
    var bucket = process.env['S3_BUCKET_NAME'];
    var basePath;

    if (s3_style === 'path') {
        _debug_log(r, 'Using path style uri : ' + '/' + bucket);
        basePath = '/' + bucket;
    } else {
        basePath = '';
    }

    return basePath;
}

/**
 * Returns the s3 path given the incoming request
 *
 * @param r HTTP request
 * @returns {string} uri for s3 request
 */
function s3uri(r) {
    var uriPath = r.variables.uri_path;
    var basePath = s3BaseUri(r);
    var path;

    // Create query parameters only if directory listing is enabled.
    if (allow_listing) {
        var queryParams = _s3DirQueryParams(uriPath, r.method);
        if (queryParams.length > 0) {
            path = basePath + '/?' + queryParams;
        } else {
            path = basePath + uriPath;
        }
    } else {
        path = basePath + uriPath;
    }

    _debug_log(r, 'S3 Request URI: ' + r.method + ' ' + path);
    return path;
}

function _s3DirQueryParams(uriPath, method) {
    if (!_isDirectory(uriPath) || method !== 'GET') {
        return '';
    }

    var path = 'delimiter=%2F'

    if (uriPath !== '/') {
        var without_leading_slash = uriPath.charAt(0) === '/' ?
            uriPath.substring(1, uriPath.length) : uriPath;
        path += '&prefix=' + encodeURIComponent(without_leading_slash);
    }

    return path;
}

/**
 * Redirects the request to the appropriate location. If the request is not
 * a read (GET/HEAD) request, then we reject the request outright by returning
 * a HTTP 405 error with a list of allowed methods.
 *
 * @param r {Request} HTTP request object
 */
function redirectToS3(r) {
    // This is a read-only S3 gateway, so we do not support any other methods
    if ( !(r.method === 'GET' || r.method === 'HEAD')) {
        _debug_log(r, 'Invalid method requested: ' + r.method);
        r.internalRedirect("@error405");
        return;
    }

    var uriPath = r.variables.uri_path;
    var isDirectoryListing = allow_listing && _isDirectory(uriPath);

    if (isDirectoryListing && r.method === 'GET') {
        r.log('### start r.internalRedirect("@s3Listing"); ')
        r.internalRedirect("@s3Listing");
    } else if (!isDirectoryListing && uriPath === '/') {
        r.log('### start error404')
        r.internalRedirect("@error404");
    } else {
        r.log('### start r.internalRedirect("@s3"); ')
        r.internalRedirect("@s3");
    }
}

/**
 * Create HTTP Authorization header for authenticating with an AWS compatible
 * v2 API.
 *
 * @param r {Request} HTTP request object
 * @param bucket {string} S3 bucket associated with request
 * @param accessId {string} User access key credential
 * @param secret {string} Secret access key
 * @returns {string} HTTP Authorization header value
 */
function signatureV2(r, bucket, accessId, secret) {
    var method = r.method;
    /* If the source URI is a directory, we are sending to S3 a query string
     * local to the root URI, so this is what we need to encode within the
     * string to sign. For example, if we are requesting /bucket/dir1/ from
     * nginx, then in S3 we need to request /?delimiter=/&prefix=dir1/
     * Thus, we can't put the path /dir1/ in the string to sign. */
    var uri = _isDirectory(r.variables.uri_path) ? '/' : r.variables.uri_path;
    var hmac = mod_hmac.createHmac('sha1', secret);
    var httpDate = s3date(r);
    var stringToSign = method + '\n\n\n' + httpDate + '\n' + '/' + bucket + uri;

    _debug_log(r, 'AWS v2 Auth Signing String: [' + stringToSign + ']');

    var s3signature = hmac.update(stringToSign).digest('base64');

    return 'AWS '+accessId+':'+s3signature;
}

/**
 * Processes the directory listing output as returned from S3 and corrupts the
 * XML output by inserting 'junk' into causing nginx to return a 404 for empty
 * directory listings.
 *
 * If anyone finds a better way to do this, please submit a PR.
 *
 * @param r {Request} HTTP request object (not used, but required for NGINX configuration)
 * @param data chunked data buffer
 * @param flags contains field that indicates that a chunk is last
 */
function filterListResponse(r, data, flags) {
    var indexIsEmpty = _parseBoolean(r.variables.indexIsEmpty);

    if (indexIsEmpty && data.indexOf('<Contents') >= 0) {
        r.variables.indexIsEmpty = false;
        indexIsEmpty = false;
    }

    if (indexIsEmpty && data.indexOf('<CommonPrefixes') >= 0) {
        r.variables.indexIsEmpty = false;
        indexIsEmpty = false;
    }

    if (flags.last && indexIsEmpty) {
        r.sendBuffer('junk', flags);
    } else {
        r.sendBuffer(data, flags);
    }
}

/**
 * Create HTTP Authorization header for authenticating with an AWS compatible
 * v4 API.
 *
 * @param r {Request} HTTP request object
 * @param timestamp {Date} timestamp associated with request (must fall within a skew)
 * @param bucket {string} S3 bucket associated with request
 * @param accessId {string} User access key credential
 * @param secret {string} Secret access key
 * @param region {string} API region associated with request
 * @returns {string} HTTP Authorization header value
 */
function signatureV4(r, timestamp, bucket, accessId, secret, region, server) {
    var eightDigitDate = _eightDigitDate(timestamp);
    var amzDatetime = _amzDatetime(timestamp, eightDigitDate);
    var signature = _buildSignatureV4(r, amzDatetime, eightDigitDate, bucket, secret, region, server);
    var authHeader = 'AWS4-HMAC-SHA256 Credential='
            .concat(accessId, '/', eightDigitDate, '/', region, '/', service, '/aws4_request,',
                'SignedHeaders=', signedHeaders, ',Signature=', signature);

    _debug_log(r, 'AWS v4 Auth header: [' + authHeader + ']');

    return authHeader;
}

/**
 * Creates a signature for use authenticating against an AWS compatible API.
 *
 * @see {@link https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html | AWS V4 Signing Process}
 * @param r {Request} HTTP request object
 * @param amzDatetime {string} ISO8601 timestamp string to sign request with
 * @param eightDigitDate {string} date in the form of 'YYYYMMDD'
 * @param bucket {string} S3 bucket associated with request
 * @param secret {string} Secret access key
 * @param region {string} API region associated with request
 * @returns {string} hex encoded hash of signature HMAC value
 * @private
 */
function _buildSignatureV4(r, amzDatetime, eightDigitDate, bucket, secret, region, server) {
    var host = server;
    if (s3_style === 'virtual' || s3_style === 'default' || s3_style === undefined) {
        host = bucket + '.' + host;
    }
    var method = r.method;
    var baseUri = s3BaseUri(r);
    var queryParams = _s3DirQueryParams(r.variables.uri_path, method);
    var uri;
    if (queryParams.length > 0) {
        if (baseUri.length > 0) {
            uri = baseUri;
        } else {
            uri = '/';
        }
    } else {
        uri = _escapeURIPath(s3uri(r));
    }
    var canonicalRequest = _buildCanonicalRequest(method, uri, queryParams, host, amzDatetime);

    _debug_log(r, 'AWS v4 Auth Canonical Request: [' + canonicalRequest + ']');

    var canonicalRequestHash = mod_hmac.createHash('sha256')
        .update(canonicalRequest)
        .digest('hex');

    _debug_log(r, 'AWS v4 Auth Canonical Request Hash: [' + canonicalRequestHash + ']');

    var stringToSign = _buildStringToSign(amzDatetime, eightDigitDate, region, canonicalRequestHash)

    _debug_log(r, 'AWS v4 Auth Signing String: [' + stringToSign + ']');

    var kSigningHash;

    /* If we have a keyval zone and key defined for caching the signing key hash,
     * then signing key caching will be enabled. By caching signing keys we can
     * accelerate the signing process because we will have four less HMAC
     * operations that have to be performed per incoming request. The signing
     * key expires every day, so our cache key can persist for 24 hours safely.
     */
    if ("variables" in r && r.variables.cache_signing_key_enabled == 1) {
        // cached value is in the format: [eightDigitDate]:[signingKeyHash]
        var cached = "signing_key_hash" in r.variables ? r.variables.signing_key_hash : "";
        var fields = _splitCachedValues(cached);
        var cachedEightDigitDate = fields[0];
        var cacheIsValid = fields.length === 2 && eightDigitDate === cachedEightDigitDate;

        // If true, use cached value
        if (cacheIsValid) {
            _debug_log(r, 'AWS v4 Using cached Signing Key Hash');
            /* We are forced to JSON encode the string returned from the HMAC
             * operation because it is in a very specific format that include
             * binary data and in order to preserve that data when persisting
             * we encode it as JSON. By doing so we can gracefully decode it
             * when reading from the cache. */
            kSigningHash = Buffer.from(JSON.parse(fields[1]));
        // Otherwise, generate a new signing key hash and store it in the cache
        } else {
            kSigningHash = _buildSigningKeyHash(secret, eightDigitDate, service, region);
            _debug_log(r, 'Writing key: ' + eightDigitDate + ':' + kSigningHash.toString('hex'));
            r.variables.signing_key_hash = eightDigitDate + ':' + JSON.stringify(kSigningHash);
        }
    // Otherwise, don't use caching at all (like when we are using NGINX OSS)
    } else {
        kSigningHash = _buildSigningKeyHash(secret, eightDigitDate, service, region);
    }

    _debug_log(r, 'AWS v4 Signing Key Hash: [' + kSigningHash.toString('hex') + ']');

    var signature = mod_hmac.createHmac('sha256', kSigningHash)
        .update(stringToSign).digest('hex');

    _debug_log(r, 'AWS v4 Authorization Header: [' + signature + ']');

    return signature;
}

/**
 * Splits the cached values into an array with two elements or returns an
 * empty array if the input string is invalid. The first element contains
 * the eight digit date string and the second element contains a JSON string
 * of the kSigningHash.
 *
 * @param cached input string to parse
 * @returns {string[]|*[]} array containing eight digit date and kSigningHash or empty
 * @private
 */
function _splitCachedValues(cached) {
    var matchedPos = cached.indexOf(':', 0)
    // Do a sanity check on the position returned, if it isn't sane, return
    // an empty array and let the caller logic process it.
    if (matchedPos < 0 || matchedPos + 1 > cached.length) {
        return []
    }

    var eightDigitDate = cached.substring(0, matchedPos)
    var kSigningHash = cached.substring(matchedPos + 1)

    return [eightDigitDate, kSigningHash]
}

/**
 * Creates a string to sign by concatenating together multiple parameters required
 * by the signatures algorithm.
 *
 * @see {@link https://docs.aws.amazon.com/general/latest/gr/sigv4-create-string-to-sign.html | String to Sign}
 * @param amzDatetime {string} ISO8601 timestamp string to sign request with
 * @param eightDigitDate {string} date in the form of 'YYYYMMDD'
 * @param region {string} region associated with server API
 * @param canonicalRequestHash {string} hex encoded hash of canonical request string
 * @returns {string} a concatenated string of the passed parameters formatted for signatures
 * @private
 */
function _buildStringToSign(amzDatetime, eightDigitDate, region, canonicalRequestHash) {
    return 'AWS4-HMAC-SHA256\n' +
        amzDatetime + '\n' +
        eightDigitDate + '/' + region + '/s3/aws4_request\n' +
        canonicalRequestHash;
}

/**
 * Creates a canonical request that will later be signed
 *
 * @see {@link https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html | Creating a Canonical Request}
 * @param method {string} HTTP method
 * @param uri {string} URI associated with request
 * @param queryParams {string} query parameters associated with request
 * @param host {string} HTTP Host header value
 * @param amzDatetime {string} ISO8601 timestamp string to sign request with
 * @returns {string} string with concatenated request parameters
 * @private
 */
function _buildCanonicalRequest(method, uri, queryParams, host, amzDatetime) {
    var canonicalHeaders = 'host:' + host + '\n' +
        'x-amz-content-sha256:' + emptyPayloadHash + '\n' +
        'x-amz-date:' + amzDatetime + '\n';

    var canonicalRequest = method+'\n';
    canonicalRequest += uri+'\n';
    canonicalRequest += queryParams+'\n';
    canonicalRequest += canonicalHeaders+'\n';
    canonicalRequest += signedHeaders+'\n';
    canonicalRequest += emptyPayloadHash;

    return canonicalRequest;
}

/**
 * Creates a signing key HMAC. This value is used to sign the request made to
 * the API.
 *
 * @param kSecret {string} secret access key
 * @param eightDigitDate {string} date in the form of 'YYYYMMDD'
 * @param service {string} name of service that request is for e.g. s3, iam, etc
 * @param region {string} region associated with server API
 * @returns {ArrayBuffer} signing HMAC
 * @private
 */
function _buildSigningKeyHash(kSecret, eightDigitDate, service, region) {
    var kDate = mod_hmac.createHmac('sha256', 'AWS4'.concat(kSecret))
        .update(eightDigitDate).digest();
    var kRegion = mod_hmac.createHmac('sha256', kDate)
        .update(region).digest();
    var kService = mod_hmac.createHmac('sha256', kRegion)
        .update(service).digest();
    var kSigning = mod_hmac.createHmac('sha256', kService)
        .update('aws4_request').digest();

    return kSigning;
}

/**
 * Formats a timestamp into a date string in the format 'YYYYMMDD'.
 *
 * @param timestamp {Date} timestamp used in signature
 * @returns {string} a formatted date string based on the input timestamp
 * @private
 */
function _eightDigitDate(timestamp) {
    var year = timestamp.getUTCFullYear();
    var month = timestamp.getUTCMonth() + 1;
    var day = timestamp.getUTCDate();

    return ''.concat(_padWithLeadingZeros(year, 4), _padWithLeadingZeros(month,2), _padWithLeadingZeros(day,2));
}

/**
 * Creates a string in the ISO601 date format (YYYYMMDD'T'HHMMSS'Z') based on
 * the supplied timestamp and date. The date is not extracted from the timestamp
 * because that operation is already done once during the signing process.
 *
 * @param timestamp {Date} timestamp to extract date from
 * @param eightDigitDate {string} 'YYYYMMDD' format date string that was already extracted from timestamp
 * @returns {string} string in the format of YYYYMMDD'T'HHMMSS'Z'
 * @private
 */
function _amzDatetime(timestamp, eightDigitDate) {
    var hours = timestamp.getUTCHours();
    var minutes = timestamp.getUTCMinutes();
    var seconds = timestamp.getUTCSeconds();

    return ''.concat(
        eightDigitDate,
        'T', _padWithLeadingZeros(hours, 2),
        _padWithLeadingZeros(minutes, 2),
        _padWithLeadingZeros(seconds, 2),
        'Z');
}

/**
 * Pads the supplied number with leading zeros.
 *
 * @param num {number|string} number to pad
 * @param size number of leading zeros to pad
 * @returns {string} a string with leading zeros
 * @private
 */
function _padWithLeadingZeros(num, size) {
    var s = "0" + num;
    return s.substr(s.length-size);
}

/**
 * Escapes the path portion of a URI without escaping the path separator
 * characters (/).
 *
 * @param uri {string} unescaped URI
 * @returns {string} URI with each path component separately escaped
 * @private
 */
function _escapeURIPath(uri) {
    var components = [];

    uri.split('/').forEach(function (item, i) {
        components[i] = encodeURIComponent(item);
    });

    return components.join('/');
}

/**
 * Determines if a given path is a directory based on whether or not the last
 * character in the path is a forward slash (/).
 *
 * @param path {string} path to parse
 * @returns {boolean} true if path is a directory
 * @private
 */
function _isDirectory(path) {
    if (path === undefined) {
        return false;
    }
    var len = path.length;

    if (len < 1) {
        return false;
    }

    return path.charAt(len - 1) === '/';
}

/**
 * Parses a string to and returns a boolean value based on its value. If the
 * string can't be parsed, this method returns null.
 *
 * @param string {*} value representing a boolean
 * @returns {boolean} boolean value of string
 * @private
 */
function _parseBoolean(string) {
    switch(string) {
        case "TRUE":
        case "true":
        case "True":
        case "YES":
        case "yes":
        case "Yes":
        case "1":
            return true;
        default:
            return false;
    }
}

/**
 * Outputs a log message to the request logger if debug messages are enabled.
 *
 * @param r {Request} HTTP request object
 * @param msg {string} message to log
 * @private
 */
function _debug_log(r, msg) {
    if (debug && "log" in r) {
        r.log(msg);
    }
}

/**
 * Checks to see if the given environment variable is present. If not, an error
 * is thrown.
 * @param envVarName {string} environment variable to check for
 * @private
 */
function _require_env_var(envVarName) {
    var isSet = envVarName in process.env;

    if (!isSet) {
        throw('Required environment variable ' + envVarName + ' is missing');
    }
}

export default {
    awsHeaderDate,
    s3date,
    s3auth,
    s3uri,
    redirectToS3,
    editAmzHeaders,
    filterListResponse,
    // These functions do not need to be exposed, but they are exposed so that
    // unit tests can run against them.
    _padWithLeadingZeros,
    _eightDigitDate,
    _amzDatetime,
    _splitCachedValues,
    _buildSigningKeyHash,
    _buildSignatureV4,
    _escapeURIPath
};
