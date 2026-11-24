import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockWorkspaceMutation } from '../src/bootstrap.js';

test('meeting record submission remains available while an automatic checkpoint is saving', () => {
  const meetingForm = {
    closest(selector) {
      return selector.includes('#meeting-form') ? this : null;
    }
  };

  assert.equal(shouldBlockWorkspaceMutation({ pending: true, profileBusy: false, sourceBusy: false, phase: 'saving', hasPendingSnapshot: false, target: meetingForm }), false);
});

test('meeting record submission remains available when a previous save is pending recovery', () => {
  const meetingForm = {
    closest(selector) {
      return selector.includes('#meeting-form') ? this : null;
    }
  };

  assert.equal(shouldBlockWorkspaceMutation({ pending: false, profileBusy: false, sourceBusy: false, phase: 'error', hasPendingSnapshot: true, target: meetingForm }), false);
});
