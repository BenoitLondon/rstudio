/*
 * bibliography.ts
 *
 * Copyright (C) 2020 by RStudio, PBC
 *
 * Unless you have received this program directly from RStudio pursuant
 * to the terms of a commercial license agreement with RStudio, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

import { Node as ProsemirrorNode } from 'prosemirror-model';

import Fuse from 'fuse.js';
import { PandocServer } from '../pandoc';
import uniqby from 'lodash.uniqby';

import { EditorUI } from '../ui';
import { ParsedYaml, parseYamlNodes } from '../yaml';
import { CSL } from '../csl';
import { ZoteroServer } from '../zotero';
import { BibliographyDataProviderLocal, kLocalBiliographyProviderKey } from './bibliography-provider_local';
import { BibliographyDataProviderZotero } from './bibliography-provider_zotero';
import { toBibLaTeX } from './bibDB';

export interface BibliographyFile {
  displayPath: string;
  fullPath: string;
  isProject: boolean;
  writable: boolean;
}

export interface BibliographyDataProvider {
  key: string;
  name: string;

  isEnabled(): boolean;
  load(docPath: string | null, resourcePath: string, yamlBlocks: ParsedYaml[]): Promise<boolean>;
  collections(): BibliographyCollection[];
  items(): BibliographySourceWithCollections[];
  itemsForCollection(collectionKey: string): BibliographySourceWithCollections[];
  bibliographyPaths(doc: ProsemirrorNode, ui: EditorUI): BibliographyFile[];
  generateBibLaTeX(ui: EditorUI, id: string, csl: CSL): Promise<string | undefined>;
  warningMessage(): string | undefined;
}

export interface BibliographyCollection {
  name: string;
  key: string;
  provider: string;
  parentKey?: string;
}

export interface Bibliography {
  sources: CSL[];
  project_biblios: string[];
}

// The individual bibliographic source
export interface BibliographySource extends CSL {
  id: string;
  providerKey: string;
}

export interface BibliographySourceWithCollections extends BibliographySource {
  collectionKeys: string[];
}

// The fields and weights that will indexed and searched
// when searching bibliographic sources
const kFields: Fuse.FuseOptionKeyObject[] = [
  { name: 'id', weight: .30 },
  { name: 'author.family', weight: .275 },
  { name: 'author.literal', weight: .275 },
  { name: 'title', weight: .1 },
  { name: 'author.given', weight: .025 },
  { name: 'issued', weight: .025 },
  { name: 'provider', weight: 0 }
];

export class BibliographyManager {

  private fuse: Fuse<BibliographySourceWithCollections, Fuse.IFuseOptions<any>> | undefined;
  private providers: BibliographyDataProvider[];
  private sources?: BibliographySourceWithCollections[];
  private writable?: boolean;

  public constructor(server: PandocServer, zoteroServer: ZoteroServer) {
    this.providers = [new BibliographyDataProviderLocal(server), new BibliographyDataProviderZotero(zoteroServer)];
  }

  public async load(ui: EditorUI, doc: ProsemirrorNode): Promise<void> {

    // read the Yaml blocks from the document
    const parsedYamlNodes = parseYamlNodes(doc);

    // Currently edited doc
    const docPath = ui.context.getDocumentPath();

    // Load each provider
    const providersNeedUpdate = await Promise.all(this.providers.map(provider => provider.load(docPath, ui.context.getDefaultResourceDir(), parsedYamlNodes)));

    // Note whether there is anything writable
    this.writable = this.shouldAllowWrites(doc, ui);

    // Once loaded, see if any of the providers required an index update
    const needsIndexUpdate = providersNeedUpdate.reduce((prev, curr) => prev || curr);

    // Update the index if anything requires that we do so
    if (needsIndexUpdate) {
      // Get the entries
      const providersEntries = this.providers.map(provider => provider.items());
      this.sources = ([] as BibliographySourceWithCollections[]).concat(...providersEntries);

      this.updateIndex(this.sources);
    }
  }

  public hasSources() {
    return this.allSources().length > 0;
  }

  public allSources(): BibliographySourceWithCollections[] {
    if (this.sources && this.isWritable()) {
      return this.sources;
    } else {
      return this.sources?.filter(source => source.providerKey === kLocalBiliographyProviderKey) || [];
    }
    return [];
  }

  public sourcesForProvider(providerKey: string): BibliographySourceWithCollections[] {
    return this.allSources().filter(item => item.providerKey === providerKey);
  }

  public sourcesForProviderCollection(provider: string, collectionKey: string): BibliographySourceWithCollections[] {
    return this.sourcesForProvider(provider).filter(item => item.collectionKeys.includes(collectionKey));
  }

  public localSources(): BibliographySourceWithCollections[] {
    return this.allSources().filter(source => source.providerKey === kLocalBiliographyProviderKey);
  }

  public isWritable(): boolean {
    return this.writable || false;
  }

  private shouldAllowWrites(doc: ProsemirrorNode, ui: EditorUI): boolean {
    const bibliographyFiles = this.bibliographyFiles(doc, ui);
    if (bibliographyFiles.length === 0) {
      // Since there are no bibliographies, we can permit writing a fresh one
      return true;
    }
    return bibliographyFiles.filter(bibFile => bibFile.writable).length > 0;
  }

  public writableBibliographyFiles(doc: ProsemirrorNode, ui: EditorUI) {
    return this.bibliographyFiles(doc, ui).filter(bibFile => bibFile.writable);
  }

  private bibliographyFiles(doc: ProsemirrorNode, ui: EditorUI): BibliographyFile[] {
    const writablePaths = this.providers.map(provider => provider.bibliographyPaths(doc, ui));
    return ([] as BibliographyFile[]).concat(...writablePaths);
  }

  public localProviders(): BibliographyDataProvider[] {
    return this.providers;
  }

  public providerName(providerKey: string): string | undefined {
    const dataProvider = this.providers.find(prov => prov.key === providerKey);
    return dataProvider?.name;
  }

  // Allows providers to generate bibLaTeX, if needed. This is useful in contexts
  // like Zotero where a user may be using the Better Bibtex plugin which can generate
  // superior BibLaTeX using things like stable citekeys with custom rules, and more.
  // 
  // If the provider doesn't provide BibLaTeX, we can generate it ourselves
  public async generateBibLaTeX(ui: EditorUI, id: string, csl: CSL, provider?: string): Promise<string | undefined> {
    const dataProvider = this.providers.find(prov => prov.key === provider);
    if (dataProvider) {
      const dataProviderBibLaTeX = dataProvider.generateBibLaTeX(ui, id, csl);
      if (dataProviderBibLaTeX) {
        return dataProviderBibLaTeX;
      }
    }
    return Promise.resolve(toBibLaTeX(id, csl));
  }

  public warning(): string | undefined {
    const warningProvider = this.providers.find(provider => provider.warningMessage());
    if (warningProvider) {
      return warningProvider.warningMessage();
    }
  }

  public warningForProvider(providerKey?: string): string | undefined {
    if (providerKey) {
      const warningProvider = this.providers.find(prov => prov.key === providerKey);
      if (warningProvider) {
        return warningProvider.warningMessage();
      }
    }
  }

  public findDoiInLocalBibliography(doi: string): BibliographySourceWithCollections | undefined {
    // NOTE: This will only search sources that have already been loaded.
    // Please be sure to use load() before calling this or
    // accept the risk that this will not properly search for a DOI if the
    // bibliography hasn't already been loaded.
    return this.localSources().find(source => source.DOI === doi);
  }

  public findIdInLocalBibliography(id: string): BibliographySourceWithCollections | undefined {
    // NOTE: This will only search sources that have already been loaded.
    // Please be sure to use load() before calling this or
    // accept the risk that this will not properly search for a DOI if the
    // bibliography hasn't already been loaded.

    return this.localSources().find(source => source.id === id);
  }

  // A general purpose search interface for filtered searching
  public search(query?: string, providerKey?: string, collectionKey?: string): BibliographySourceWithCollections[] {
    const limit = 1000;
    if (query) {
      if (providerKey && collectionKey) {
        return this.searchProviderCollection(query, limit, providerKey, collectionKey);
      } else if (providerKey) {
        return this.searchProvider(query, limit, providerKey);
      } else {
        return this.searchAllSources(query, limit);
      }
    } else {
      if (providerKey && collectionKey) {
        return this.sourcesForProviderCollection(providerKey, collectionKey);
      } else if (providerKey) {
        return this.sourcesForProvider(providerKey);
      } else {
        return this.allSources();
      }
    }
  }

  public searchAllSources(query: string, limit: number): BibliographySourceWithCollections[] {

    // NOTE: This will only search sources that have already been loaded.
    // Please be sure to use load() before calling this or
    // accept the risk that this will not properly search for a source if the
    // bibliography hasn't already been loaded.
    if (this.fuse) {
      const options = {
        isCaseSensitive: false,
        shouldSort: true,
        includeMatches: false,
        includeScore: false,
        limit,
        keys: kFields,
      };

      // NOTE: Search performance can really drop off for long strings
      // Test cases start at 20ms to search for a single character
      // grow to 270ms to search for 20 character string
      // grow to 1060ms to search for 40 character string 
      const results: Array<Fuse.FuseResult<BibliographySource>> = this.fuse.search(query, options);


      const items = results.map((result: { item: any }) => result.item);

      // Filter out any non local items if this isn't a writable bibliography
      const filteredItems = this.isWritable() ? items : items.filter(item => item.provider === kLocalBiliographyProviderKey);

      return filteredItems;

    } else {
      return [];
    }
  }

  // Search only a specific provider
  public searchProvider(query: string, limit: number, providerKey: string): BibliographySourceWithCollections[] {
    return this.searchAllSources(query, limit).filter(item => item.providerKey === providerKey);
  }

  // Search a specific provider and collection
  public searchProviderCollection(query: string, limit: number, providerKey: string, collectionKey: string): BibliographySourceWithCollections[] {
    return this.searchProvider(query, limit, providerKey).filter(item => item.collectionKeys.includes(collectionKey));
  }

  private updateIndex(bibSources: BibliographySourceWithCollections[]) {
    // build search index
    const options = {
      keys: kFields.map(field => field.name),
    };
    const index = Fuse.createIndex(options.keys, bibSources);
    this.fuse = new Fuse(bibSources, options, index);
  }

}

