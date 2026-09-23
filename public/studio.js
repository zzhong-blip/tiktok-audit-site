const $ = (id) => document.getElementById(id);
const state = { connected: false, creator: null, mode: 'video', uploadedPhotos: [], videoDurationSec: null, previewUrls: [] };

function showResult(message, kind = '') {
  const el = $('result');
  el.textContent = message;
  el.className = `status result ${kind}`.trim();
  el.classList.remove('hidden');
}

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : { message: await res.text() };
  if (!res.ok) {
    const error = new Error(body.error || body.message || `Request failed (${res.status})`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

function setConnected(connected) {
  state.connected = connected;
  $('connectButton').classList.toggle('hidden', connected);
  $('refreshCreator').classList.toggle('hidden', !connected);
  $('disconnectButton').classList.toggle('hidden', !connected);
  updatePublishEnabled();
}

function updatePublishEnabled() {
  const hasMedia = state.mode === 'video'
    ? Boolean($('videoFile').files?.[0])
    : Boolean($('photoFiles').files?.length);
  const commercialReady = !$('commercialToggle').checked || $('brandOrganic').checked || $('brandContent').checked;
  const maxDuration = Number(state.creator?.max_video_post_duration_sec || 0);
  const durationReady = state.mode !== 'video' || (
    Number.isFinite(state.videoDurationSec) &&
    (maxDuration <= 0 || state.videoDurationSec <= maxDuration)
  );
  const ready = state.connected && state.creator && hasMedia && Boolean($('privacy').value)
    && commercialReady && durationReady && $('consent').checked;
  $('publishButton').disabled = !ready;
  $('publishButton').title = $('commercialToggle').checked && !commercialReady
    ? 'You need to indicate if your content promotes yourself, a third party, or both.'
    : '';
}

function applyCreatorInfo(creator) {
  state.creator = creator;
  $('accountProfile').classList.remove('hidden');
  $('accountName').textContent = creator.creator_nickname || 'Connected creator';
  $('accountHandle').textContent = creator.creator_username ? `@${creator.creator_username}` : 'TikTok creator';
  if (creator.creator_avatar_url) $('accountAvatar').src = creator.creator_avatar_url;
  $('accountStatus').textContent = 'Connected. Publishing controls are current.';
  $('accountStatus').className = 'status ok';

  const privacy = $('privacy');
  privacy.innerHTML = '<option value="" selected disabled>Select a privacy level</option>';
  for (const value of creator.privacy_level_options || []) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
    privacy.appendChild(opt);
  }

  setInteractionAvailability('allowComment', 'commentWrap', creator.comment_disabled);
  setInteractionAvailability('allowDuet', 'duetWrap', creator.duet_disabled || state.mode === 'photo');
  setInteractionAvailability('allowStitch', 'stitchWrap', creator.stitch_disabled || state.mode === 'photo');
  updatePublishEnabled();
}

function setInteractionAvailability(inputId, wrapId, disabled) {
  const input = $(inputId);
  input.checked = false;
  input.disabled = Boolean(disabled);
  $(wrapId).classList.toggle('disabled', Boolean(disabled));
}

async function refreshSession() {
  try {
    const data = await api('/api/tiktok/session');
    setConnected(Boolean(data.connected));
    if (!data.connected) {
      $('accountStatus').textContent = 'Not connected.';
      $('accountStatus').className = 'status';
      state.creator = null;
      $('accountProfile').classList.add('hidden');
      return;
    }
    await refreshCreator();
  } catch (err) {
    setConnected(false);
    $('accountStatus').textContent = `Connection check failed: ${err.message}`;
    $('accountStatus').className = 'status error';
  }
}

async function refreshCreator() {
  $('accountStatus').textContent = 'Refreshing creator controls…';
  $('accountStatus').className = 'status';
  try {
    const data = await api('/api/tiktok/creator-info', { method: 'POST' });
    applyCreatorInfo(data.creator);
  } catch (err) {
    state.creator = null;
    updatePublishEnabled();
    $('accountStatus').textContent = err.status === 401 ? 'Session expired. Please connect again.' : `Could not load creator controls: ${err.message}`;
    $('accountStatus').className = 'status error';
  }
}

function switchMode(mode) {
  state.mode = mode;
  const isVideo = mode === 'video';
  $('videoTab').classList.toggle('active', isVideo);
  $('photoTab').classList.toggle('active', !isVideo);
  $('videoTab').setAttribute('aria-selected', String(isVideo));
  $('photoTab').setAttribute('aria-selected', String(!isVideo));
  $('videoFields').classList.toggle('hidden', !isVideo);
  $('photoFields').classList.toggle('hidden', isVideo);
  $('photoDescriptionField').classList.toggle('hidden', isVideo);
  $('title').maxLength = isVideo ? 2200 : 90;
  $('titleHelp').textContent = isVideo ? 'Maximum 2,200 UTF-16 code units for video posts.' : 'Maximum 90 UTF-16 code units for photo titles.';
  if (state.creator) {
    setInteractionAvailability('allowDuet', 'duetWrap', state.creator.duet_disabled || !isVideo);
    setInteractionAvailability('allowStitch', 'stitchWrap', state.creator.stitch_disabled || !isVideo);
  }
  $('privacy').value = '';
  $('consent').checked = false;
  $('commercialToggle').checked = false;
  $('brandOrganic').checked = false;
  $('brandContent').checked = false;
  $('commercialOptions').classList.add('hidden');
  updateCommercialRules();
  showResult('Review all controls again after switching post type.', 'warn');
}

function collectPostInfo() {
  return {
    privacy_level: $('privacy').value,
    title: $('title').value.trim(),
    disable_comment: !$('allowComment').checked,
    disable_duet: !$('allowDuet').checked,
    disable_stitch: !$('allowStitch').checked,
    commercial_disclosure: $('commercialToggle').checked,
    brand_content_toggle: $('commercialToggle').checked && $('brandContent').checked,
    brand_organic_toggle: $('commercialToggle').checked && $('brandOrganic').checked,
    is_aigc: $('isAigc').checked,
    consent: $('consent').checked,
  };
}

function chooseChunking(size) {
  const min = 5 * 1024 * 1024;
  const preferred = 32 * 1024 * 1024;
  if (size <= min) return { chunkSize: size, totalChunks: 1 };
  const chunkSize = preferred;
  const totalChunks = Math.max(1, Math.floor(size / chunkSize));
  return { chunkSize, totalChunks };
}

async function relayVideoChunks(file, uploadUrl, chunkSize, totalChunks) {
  $('progressWrap').classList.add('active');
  let offset = 0;
  for (let i = 0; i < totalChunks; i += 1) {
    const endExclusive = i === totalChunks - 1 ? file.size : offset + chunkSize;
    const chunk = file.slice(offset, endExclusive);
    const rangeEnd = endExclusive - 1;
    $('progressLabel').textContent = `Uploading video chunk ${i + 1} of ${totalChunks}…`;
    const res = await fetch('/api/tiktok/video/upload', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': file.type || 'video/mp4',
        'Content-Range': `bytes ${offset}-${rangeEnd}/${file.size}`,
        'X-TikTok-Upload-URL': uploadUrl,
      },
      body: chunk,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch {}
      throw new Error(`Video transfer failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    offset = endExclusive;
    $('progress').value = Math.round((offset / file.size) * 100);
  }
}

async function publishVideo() {
  const file = $('videoFile').files[0];
  if (!file) throw new Error('Choose a video file first.');
  if (!Number.isFinite(state.videoDurationSec)) throw new Error('Wait for the video preview to load before publishing.');
  const maxDuration = Number(state.creator?.max_video_post_duration_sec || 0);
  if (maxDuration > 0 && state.videoDurationSec > maxDuration) throw new Error(`This creator can post videos up to ${maxDuration} seconds. The selected video is ${Math.ceil(state.videoDurationSec)} seconds.`);
  const post = collectPostInfo();
  const { chunkSize, totalChunks } = chooseChunking(file.size);
  const init = await api('/api/tiktok/video/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...post, video_size: file.size, video_duration_sec: state.videoDurationSec, chunk_size: chunkSize, total_chunk_count: totalChunks }),
  });
  if (!init.upload_url) throw new Error('TikTok did not return an upload URL.');
  await relayVideoChunks(file, init.upload_url, chunkSize, totalChunks);
  return init.publish_id;
}

async function uploadPhotos() {
  const files = [...$('photoFiles').files];
  if (!files.length) throw new Error('Choose at least one photo.');
  if (files.length > 35) throw new Error('TikTok supports up to 35 photos in one post.');
  state.uploadedPhotos = [];
  $('photoList').innerHTML = '';
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const form = new FormData();
    form.append('photo', file);
    showResult(`Uploading temporary photo ${i + 1} of ${files.length}…`);
    const uploaded = await api('/api/media/upload', { method: 'POST', body: form });
    state.uploadedPhotos.push(uploaded);
    const chip = document.createElement('div');
    chip.className = 'photo-chip';
    chip.textContent = `${file.name} — ready`;
    $('photoList').appendChild(chip);
  }
}

async function publishPhotos() {
  if (!state.uploadedPhotos.length) await uploadPhotos();
  const post = collectPostInfo();
  const data = await api('/api/tiktok/photo/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...post,
      description: $('photoDescription').value.trim(),
      photo_images: state.uploadedPhotos.map((item) => item.url),
      photo_cover_index: 0,
    }),
  });
  return data.publish_id;
}

async function pollStatus(publishId) {
  if (!publishId) return;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1200 : 2500));
    const data = await api('/api/tiktok/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publish_id: publishId }),
    });
    const status = data.status?.status || 'UNKNOWN';
    showResult(`Publish ID: ${publishId}\nStatus: ${status}${data.status?.fail_reason ? `\nReason: ${data.status.fail_reason}` : ''}`, status === 'FAILED' ? 'error' : 'ok');
    if (['PUBLISH_COMPLETE', 'FAILED'].includes(status)) return;
  }
}

$('videoTab').addEventListener('click', () => switchMode('video'));
$('photoTab').addEventListener('click', () => switchMode('photo'));
$('refreshCreator').addEventListener('click', refreshCreator);
$('disconnectButton').addEventListener('click', async () => {
  await api('/api/tiktok/logout', { method: 'POST' });
  state.creator = null;
  setConnected(false);
  $('accountProfile').classList.add('hidden');
  $('accountStatus').textContent = 'Disconnected.';
  $('accountStatus').className = 'status';
});
function clearPreviewUrls() {
  for (const url of state.previewUrls) URL.revokeObjectURL(url);
  state.previewUrls = [];
}

$('videoFile').addEventListener('change', () => {
  clearPreviewUrls();
  state.videoDurationSec = null;
  const file = $('videoFile').files[0];
  const preview = $('videoPreview');
  if (!file) {
    preview.classList.add('hidden');
    preview.removeAttribute('src');
    updatePublishEnabled();
    return;
  }
  const url = URL.createObjectURL(file);
  state.previewUrls.push(url);
  preview.src = url;
  preview.classList.remove('hidden');
  preview.onloadedmetadata = () => {
    state.videoDurationSec = preview.duration;
    const maxDuration = Number(state.creator?.max_video_post_duration_sec || 0);
    $('videoDurationHelp').textContent = maxDuration > 0
      ? `Preview ready: ${Math.ceil(preview.duration)}s. Connected creator maximum: ${maxDuration}s.`
      : `Preview ready: ${Math.ceil(preview.duration)}s. The file is transferred only after your explicit confirmation.`;
    updatePublishEnabled();
  };
  updatePublishEnabled();
});

$('photoFiles').addEventListener('change', () => {
  state.uploadedPhotos = [];
  $('photoList').innerHTML = '';
  clearPreviewUrls();
  $('photoPreview').innerHTML = '';
  for (const file of [...$('photoFiles').files]) {
    const url = URL.createObjectURL(file);
    state.previewUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Preview of ${file.name}`;
    $('photoPreview').appendChild(img);
  }
  updatePublishEnabled();
});

function updateCommercialRules() {
  const enabled = $('commercialToggle').checked;
  $('commercialOptions').classList.toggle('hidden', !enabled);
  if (!enabled) {
    $('brandOrganic').checked = false;
    $('brandContent').checked = false;
  }

  const branded = enabled && $('brandContent').checked;
  const ownBrand = enabled && $('brandOrganic').checked;
  const privacy = $('privacy');
  for (const option of [...privacy.options]) {
    if (!option.value) continue;
    const blocked = branded && !['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS'].includes(option.value);
    option.disabled = blocked;
    option.title = option.value === 'SELF_ONLY' && blocked ? 'Branded content visibility cannot be set to private.' : '';
  }
  if (branded && privacy.value && !['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS'].includes(privacy.value)) {
    privacy.value = '';
    showResult('Branded content visibility cannot be set to private. Select Public or Friends.', 'warn');
  }

  const hint = $('commercialHint');
  if (!enabled) {
    hint.textContent = '';
    hint.classList.add('hidden');
  } else if (branded) {
    hint.textContent = "Your photo/video will be labeled as 'Paid partnership'";
    hint.classList.remove('hidden');
  } else if (ownBrand) {
    hint.textContent = "Your photo/video will be labeled as 'Promotional content'";
    hint.classList.remove('hidden');
  } else {
    hint.textContent = 'You need to indicate if your content promotes yourself, a third party, or both.';
    hint.classList.remove('hidden');
  }

  $('consentText').innerHTML = branded
    ? `By posting, you agree to TikTok's <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener noreferrer">Branded Content Policy</a> and <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer">Music Usage Confirmation</a>.`
    : `By posting, you agree to TikTok's <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer">Music Usage Confirmation</a>.`;
  updatePublishEnabled();
}

$('commercialToggle').addEventListener('change', updateCommercialRules);
$('brandContent').addEventListener('change', updateCommercialRules);
$('brandOrganic').addEventListener('change', updateCommercialRules);
$('privacy').addEventListener('change', updateCommercialRules);
$('consent').addEventListener('change', updatePublishEnabled);


$('postForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('result').classList.add('hidden');
  $('publishButton').disabled = true;
  try {
    if (!$('privacy').value) throw new Error('Select a privacy level.');
    if ($('commercialToggle').checked && !$('brandOrganic').checked && !$('brandContent').checked) throw new Error('Choose Your brand, Branded content, or both for commercial content.');
    if (!$('consent').checked) throw new Error('Confirm consent before publishing.');
    const publishId = state.mode === 'video' ? await publishVideo() : await publishPhotos();
    showResult(`Publication initialized.\nPublish ID: ${publishId}`, 'ok');
    await pollStatus(publishId);
  } catch (err) {
    showResult(err.message || 'Unable to publish.', 'error');
  } finally {
    updatePublishEnabled();
  }
});

refreshSession();