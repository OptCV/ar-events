import { describe, expect, it } from 'vitest';
import { DraftExperienceScene, IDENTITY_TRANSFORM, type Action, type SceneNode } from '@ar-creator/schema';
import { actionTitle, checkAction, describeAction, removeAction, removeNodeCascade, setPrimary, setTapAction, upsertAction, usageOf, type Content } from './actions.ts';

const node = (id: string, extra: Record<string, unknown> = {}): SceneNode => ({ id, kind: 'primitive', shape: 'box', name: id, transform: IDENTITY_TRANSFORM, visible: true, locked: false, ...extra }) as SceneNode;
const link: Action = { id: 'a-link', type: 'open-url', url: 'https://example.com/shop', label: 'Shop' };
const toggle: Action = { id: 'a-toggle', type: 'toggle-visibility', nodeId: 'box' };
const content = (): Content => ({
  nodes: [node('box', { actionId: 'a-link' }), node('lamp', { actionId: 'a-toggle' }), node('pin', { kind: 'hotspot', actionId: 'a-toggle' })],
  actions: [link, toggle],
  primaryActionId: 'a-link',
});
/** Every result must still be a valid draft scene (what the server accepts). */
const valid = (c: Content) => DraftExperienceScene.safeParse({ schemaVersion: 1, placement: { mode: 'floor' }, ...c }).success;

describe('actions (M12)', () => {
  it('describes actions and button titles in plain words', () => {
    const c = content();
    expect(describeAction(link, c.nodes)).toBe('Open https://example.com/shop');
    expect(describeAction(toggle, c.nodes)).toBe('Show or hide “box”');
    expect(describeAction({ id: 'p', type: 'play-animation', nodeId: 'gone', clip: 'Walk' }, c.nodes)).toBe('Play “Walk” on a removed object');
    expect(actionTitle(link, c.nodes)).toBe('Shop');
    expect(actionTitle({ id: 'm', type: 'mailto', address: 'a@b.co' }, c.nodes)).toBe('Send email');
  });

  it('validates with the scene schema and explains problems', () => {
    expect(checkAction({ id: 'x', type: 'open-url', url: 'http://example.com' })).toMatchObject({ ok: false, field: 'url', message: 'Enter a full web address starting with https://' });
    expect(checkAction({ id: 'x', type: 'open-url', url: 'javascript:alert(1)' })).toMatchObject({ ok: false, field: 'url' });
    expect(checkAction({ id: 'x', type: 'mailto', address: 'nope' })).toMatchObject({ ok: false, field: 'address' });
    expect(checkAction({ id: 'x', type: 'tel', number: '+1 (555) 010-0000' })).toMatchObject({ ok: true });
    expect(checkAction({ id: 'x', type: 'open-url', url: 'https://a.example', label: 'x'.repeat(61) })).toMatchObject({ ok: false, field: 'label' });
  });

  it('only web links can be the primary button; editing the primary into another type clears it', () => {
    const c = content();
    expect(setPrimary(c, 'a-toggle')).toBe(c);
    expect(setPrimary(c, null)).not.toHaveProperty('primaryActionId');
    const edited = upsertAction(c, { id: 'a-link', type: 'mailto', address: 'shop@example.com' });
    expect(edited).not.toHaveProperty('primaryActionId');
    expect(valid(edited)).toBe(true);
  });

  it('tap actions: set and clear; hotspots always keep theirs', () => {
    const c = content();
    expect(setTapAction(c, 'box', null).nodes[0]).not.toHaveProperty('actionId');
    expect(setTapAction(c, 'pin', null).nodes[2]).toMatchObject({ actionId: 'a-toggle' });
    expect(setTapAction(c, 'pin', 'a-link').nodes[2]).toMatchObject({ actionId: 'a-link' });
  });

  it('deleting an action clears its uses and says so; a hotspot blocks it', () => {
    const c = content();
    expect(removeAction(c, 'a-toggle')).toEqual({ ok: false, message: 'Used by “pin”. Give it another action or remove it first.' });
    const r = removeAction(c, 'a-link');
    expect(r.ok && r.cleared).toEqual(['“box” no longer does anything when tapped', 'the experience has no main button now']);
    expect(r.ok && valid(r.content)).toBe(true);
    expect(r.ok && usageOf(r.content, 'a-link')).toEqual({ nodes: [], primary: false });
  });

  it('removing an object removes the actions that target it and hotspots left without an action — and lists them', () => {
    const r = removeNodeCascade(content(), 'box');
    expect(r.removed).toEqual(['the action “Show or hide “box””', 'the hotspot “pin”']);
    expect(r.content.actions.map((a) => a.id)).toEqual(['a-link']);
    expect(r.content.nodes.map((n) => n.id)).toEqual(['lamp']);
    expect(r.content.nodes[0]).not.toHaveProperty('actionId');
    expect(r.content.primaryActionId).toBe('a-link');
    expect(valid(r.content)).toBe(true);
    // Unrelated objects: nothing else changes.
    expect(removeNodeCascade(content(), 'lamp').removed).toEqual([]);
  });
});
