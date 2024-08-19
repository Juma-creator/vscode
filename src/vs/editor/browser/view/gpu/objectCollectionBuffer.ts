/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from 'vs/base/common/event';
import { Disposable, type IDisposable } from 'vs/base/common/lifecycle';

export interface ObjectCollectionBufferPropertySpec {
	name: string;
}

export type ObjectCollectionPropertyValues<T extends ObjectCollectionBufferPropertySpec[]> = {
	[K in T[number]['name']]: number;
};

export interface IObjectCollectionBuffer<T extends ObjectCollectionBufferPropertySpec[]> extends IDisposable {
	/**
	 * The underlying buffer. This **should not** be modified externally.
	 */
	readonly buffer: ArrayBuffer;
	/**
	 * A view of the underlying buffer. This **should not** be modified externally.
	 */
	readonly view: Float32Array;
	/**
	 * The size of the used portion of the buffer (in bytes).
	 */
	readonly bufferUsedSize: number;
	/**
	 * The size of the used portion of the view (in float32s).
	 */
	readonly viewUsedSize: number;

	readonly onDidChange: Event<void>;

	/**
	 * Creates an entry in the collection. This will return a managed object that can be modified
	 * which will update the underlying buffer.
	 * @param data The data of the entry.
	 */
	createEntry(data: ObjectCollectionPropertyValues<T>): IObjectCollectionBufferEntry<T>;
}

export interface IObjectCollectionBufferEntry<T extends ObjectCollectionBufferPropertySpec[]> extends IDisposable {
	set(propertyName: T[number]['name'], value: number): void;
	get(propertyName: T[number]['name']): number;
}

export function createObjectCollectionBuffer<T extends ObjectCollectionBufferPropertySpec[]>(
	propertySpecs: T,
	capacity: number
): IObjectCollectionBuffer<T> {
	return new ObjectCollectionBuffer<T>(propertySpecs, capacity);
}

class ObjectCollectionBuffer<T extends ObjectCollectionBufferPropertySpec[]> extends Disposable implements IObjectCollectionBuffer<T> {
	buffer: ArrayBuffer;
	view: Float32Array;

	get bufferUsedSize() {
		return this.viewUsedSize * Float32Array.BYTES_PER_ELEMENT;
	}
	get viewUsedSize() {
		return this._entries.size * this._entrySize;
	}

	private readonly _propertySpecsMap: Map<string, ObjectCollectionBufferPropertySpec & { offset: number }> = new Map();
	private readonly _entrySize: number;
	// Linked list for fast access to tail and insertion in middle?
	private readonly _entries: Set<ObjectCollectionBufferEntry<T>> = new Set();

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		public propertySpecs: T,
		public capacity: number
	) {
		super();

		this.view = new Float32Array(capacity * 2);
		this.buffer = this.view.buffer;
		this._entrySize = propertySpecs.length;
		for (let i = 0; i < propertySpecs.length; i++) {
			const spec = {
				offset: i,
				...propertySpecs[i]
			};
			this._propertySpecsMap.set(spec.name, spec);
		}
	}

	createEntry(data: ObjectCollectionPropertyValues<T>): IObjectCollectionBufferEntry<T> {
		if (this._entries.size === this.capacity) {
			throw new Error(`Cannot create more entries ObjectCollectionBuffer entries (capacity=${this.capacity})`);
		}

		const value = new ObjectCollectionBufferEntry(this.view, this._propertySpecsMap, this._entries.size, data);
		// TODO: Needs unregistering when disposed
		this._register(value.onDidChange(() => {
			// TODO: Listen and react to change
			this._onDidChange.fire();
		}));
		this._register(value.onWillDispose(() => {
			// TODO: A linked list could make this O(1)
			const deletedEntryIndex = value.i;
			this._entries.delete(value);

			// Shift all entries after the deleted entry to the left
			this.view.set(this.view.subarray(deletedEntryIndex * this._entrySize + 2, this._entries.size * this._entrySize + 2), deletedEntryIndex * this._entrySize);

			// Update entries to reflect the new i
			for (const entry of this._entries) {
				if (entry.i > deletedEntryIndex) {
					entry.i--;
				}
			}

			// There may be stale data at the end but it doesn't matter
		}));
		this._entries.add(value);
		return value;
	}
}

class ObjectCollectionBufferEntry<T extends ObjectCollectionBufferPropertySpec[]> extends Disposable implements IObjectCollectionBufferEntry<T> {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	constructor(
		private _view: Float32Array,
		private _propertySpecsMap: Map<string, ObjectCollectionBufferPropertySpec & { offset: number }>,
		public i: number,
		data: ObjectCollectionPropertyValues<T>,
	) {
		super();
		for (const propertySpec of this._propertySpecsMap.values()) {
			// TODO: Type isn't that safe
			this._view[this.i * this._propertySpecsMap.size + propertySpec.offset] = data[propertySpec.name as keyof typeof data];
		}
	}

	override dispose() {
		this._onWillDispose.fire();
		super.dispose();
	}

	set(propertyName: T[number]['name'], value: number): void {
		// TODO: 2 -> pull from spec
		this._view[this.i * this._propertySpecsMap.size + this._propertySpecsMap.get(propertyName)!.offset] = value;
		this._onDidChange.fire();
	}

	get(propertyName: T[number]['name']): number {
		return this._view[this.i * this._propertySpecsMap.size + this._propertySpecsMap.get(propertyName)!.offset];
	}
}