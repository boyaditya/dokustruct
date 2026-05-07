/**
 * PORTING NOTE: schemas.py → schemas.js
 *
 * WORKAROUND: Python uses pydantic BaseModel for runtime validation
 * REASON: pydantic is not available in the browser
 * SOLUTION: Plain JS classes with JSDoc typing; constructor validates required fields
 *
 * AFFECTED METHODS: All model classes → plain JS classes with validation in constructor
 */

/**
 * S3 configuration object.
 * @typedef {Object} S3ConfigData
 * @property {string} bucketName
 * @property {string} accessKey
 * @property {string} secretKey
 * @property {string} endpointUrl
 * @property {string} [addressingStyle]
 */

export class S3Config {
  /**
   * @param {S3ConfigData} data
   */
  constructor(data) {
    if (!data.bucketName || data.bucketName.length < 1) throw new Error('bucketName is required');
    if (!data.accessKey || data.accessKey.length < 1) throw new Error('accessKey is required');
    if (!data.secretKey || data.secretKey.length < 1) throw new Error('secretKey is required');
    if (!data.endpointUrl || data.endpointUrl.length < 1) throw new Error('endpointUrl is required');

    /** @type {string} */
    this.bucketName = data.bucketName;
    /** @type {string} */
    this.accessKey = data.accessKey;
    /** @type {string} */
    this.secretKey = data.secretKey;
    /** @type {string} */
    this.endpointUrl = data.endpointUrl;
    /** @type {string} */
    this.addressingStyle = data.addressingStyle ?? 'auto';
  }
}

/**
 * Page dimension information.
 * @typedef {Object} PageInfoData
 * @property {number} w - page width
 * @property {number} h - page height
 */

export class PageInfo {
  /**
   * @param {PageInfoData} data
   */
  constructor(data) {
    /** @type {number} */
    this.w = data.w;
    /** @type {number} */
    this.h = data.h;
  }
}