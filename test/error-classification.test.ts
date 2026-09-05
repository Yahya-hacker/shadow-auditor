import {expect} from 'chai';

import {toUserFacingError} from '../src/utils/error-classification.js';

describe('toUserFacingError', () => {
  it('maps the opaque SDK "no body" message to actionable guidance', () => {
    const message = toUserFacingError('400 status code (no body)');

    expect(message).to.include('HTTP 400');
    expect(message).to.include('model name and base URL');
    expect(message).to.not.include('status code (no body)');
  });

  it('recognises other HTTP statuses in the same shape', () => {
    const message = toUserFacingError('422 status code (no body)');

    expect(message).to.include('HTTP 422');
  });

  it('keeps authentic authentication failures distinct from empty-body rejections', () => {
    expect(toUserFacingError('401 status code (no body)')).to.equal(
      'Authentication failed. Run again with --reconfigure.',
    );
  });
});