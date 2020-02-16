/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

/**
 * ECharts option manager
 */


import * as zrUtil from 'zrender/src/core/util';
import * as modelUtil from '../util/model';
import ComponentModel, { ComponentModelConstructor } from './Component';
import ExtensionAPI from '../ExtensionAPI';
import { OptionPreprocessor, MediaQuery, ECUnitOption, MediaUnit, ECOption } from '../util/types';
import GlobalModel from './Global';

var each = zrUtil.each;
var clone = zrUtil.clone;
var map = zrUtil.map;
var merge = zrUtil.merge;

var QUERY_REG = /^(min|max)?(.+)$/;

interface ParsedRawOption {
    baseOption: ECUnitOption;
    timelineOptions: ECUnitOption[];
    mediaDefault: MediaUnit;
    mediaList: MediaUnit[];
}

/**
 * TERM EXPLANATIONS:
 * See `ECOption` and `ECUnitOption` in `src/util/types.ts`.
 */
class OptionManager {

    private _api: ExtensionAPI;

    private _timelineOptions: ECUnitOption[] = [];

    private _mediaList: MediaUnit[] = [];

    private _mediaDefault: MediaUnit;

    /**
     * -1, means default.
     * empty means no media.
     */
    private _currentMediaIndices: number[] = [];

    private _optionBackup: ParsedRawOption;

    private _newBaseOption: ECUnitOption;

    // timeline.notMerge is not supported in ec3. Firstly there is rearly
    // case that notMerge is needed. Secondly supporting 'notMerge' requires
    // rawOption cloned and backuped when timeline changed, which does no
    // good to performance. What's more, that both timeline and setOption
    // method supply 'notMerge' brings complex and some problems.
    // Consider this case:
    // (step1) chart.setOption({timeline: {notMerge: false}, ...}, false);
    // (step2) chart.setOption({timeline: {notMerge: true}, ...}, false);

    constructor(api: ExtensionAPI) {
        this._api = api;
    }

    setOption(rawOption: ECOption, optionPreprocessorFuncs: OptionPreprocessor[]): void {
        if (rawOption) {
            // That set dat primitive is dangerous if user reuse the data when setOption again.
            zrUtil.each(modelUtil.normalizeToArray((rawOption as ECUnitOption).series), function (series) {
                series && series.data && zrUtil.isTypedArray(series.data) && zrUtil.setAsPrimitive(series.data);
            });
        }

        // Caution: some series modify option data, if do not clone,
        // it should ensure that the repeat modify correctly
        // (create a new object when modify itself).
        rawOption = clone(rawOption);

        // FIXME
        // If some property is set in timeline options or media option but
        // not set in baseOption, a warning should be given.

        var oldOptionBackup = this._optionBackup;
        var newParsedOption = parseRawOption(
            rawOption, optionPreprocessorFuncs, !oldOptionBackup
        );
        this._newBaseOption = newParsedOption.baseOption;

        // For setOption at second time (using merge mode);
        if (oldOptionBackup) {
            // Only baseOption can be merged.
            mergeOption(oldOptionBackup.baseOption, newParsedOption.baseOption);

            // For simplicity, timeline options and media options do not support merge,
            // that is, if you `setOption` twice and both has timeline options, the latter
            // timeline opitons will not be merged to the formers, but just substitude them.
            if (newParsedOption.timelineOptions.length) {
                oldOptionBackup.timelineOptions = newParsedOption.timelineOptions;
            }
            if (newParsedOption.mediaList.length) {
                oldOptionBackup.mediaList = newParsedOption.mediaList;
            }
            if (newParsedOption.mediaDefault) {
                oldOptionBackup.mediaDefault = newParsedOption.mediaDefault;
            }
        }
        else {
            this._optionBackup = newParsedOption;
        }
    }

    mountOption(isRecreate: boolean): ECUnitOption {
        var optionBackup = this._optionBackup;

        this._timelineOptions = map(optionBackup.timelineOptions, clone);
        this._mediaList = map(optionBackup.mediaList, clone);
        this._mediaDefault = clone(optionBackup.mediaDefault);
        this._currentMediaIndices = [];

        return clone(isRecreate
            // this._optionBackup.baseOption, which is created at the first `setOption`
            // called, and is merged into every new option by inner method `mergeOption`
            // each time `setOption` called, can be only used in `isRecreate`, because
            // its reliability is under suspicion. In other cases option merge is
            // performed by `model.mergeOption`.
            ? optionBackup.baseOption : this._newBaseOption
        );
    }

    getTimelineOption(ecModel: GlobalModel): ECUnitOption {
        var option;
        var timelineOptions = this._timelineOptions;

        if (timelineOptions.length) {
            // getTimelineOption can only be called after ecModel inited,
            // so we can get currentIndex from timelineModel.
            var timelineModel = ecModel.getComponent('timeline');
            if (timelineModel) {
                option = clone(
                    // FIXME:TS as TimelineModel or quivlant interface
                    timelineOptions[(timelineModel as any).getCurrentIndex()]
                );
            }
        }

        return option;
    }

    getMediaOption(ecModel: GlobalModel): ECUnitOption[] {
        var ecWidth = this._api.getWidth();
        var ecHeight = this._api.getHeight();
        var mediaList = this._mediaList;
        var mediaDefault = this._mediaDefault;
        var indices = [];
        var result: ECUnitOption[] = [];

        // No media defined.
        if (!mediaList.length && !mediaDefault) {
            return result;
        }

        // Multi media may be applied, the latter defined media has higher priority.
        for (var i = 0, len = mediaList.length; i < len; i++) {
            if (applyMediaQuery(mediaList[i].query, ecWidth, ecHeight)) {
                indices.push(i);
            }
        }

        // FIXME
        // 是否mediaDefault应该强制用户设置，否则可能修改不能回归。
        if (!indices.length && mediaDefault) {
            indices = [-1];
        }

        if (indices.length && !indicesEquals(indices, this._currentMediaIndices)) {
            result = map(indices, function (index) {
                return clone(
                    index === -1 ? mediaDefault.option : mediaList[index].option
                );
            });
        }
        // Otherwise return nothing.

        this._currentMediaIndices = indices;

        return result;
    }

}

function parseRawOption(
    rawOption: ECOption,
    optionPreprocessorFuncs: OptionPreprocessor[],
    isNew: boolean
): ParsedRawOption {
    var timelineOptions = [];
    var mediaList: MediaUnit[] = [];
    var mediaDefault: MediaUnit;
    var baseOption;

    // Compatible with ec2.
    var timelineOpt = (rawOption as any).timeline;

    if (rawOption.baseOption) {
        baseOption = rawOption.baseOption;
    }

    // For timeline
    if (timelineOpt || rawOption.options) {
        baseOption = baseOption || {};
        timelineOptions = (rawOption.options || []).slice();
    }

    // For media query
    if (rawOption.media) {
        baseOption = baseOption || {};
        var media = rawOption.media;
        each(media, function (singleMedia) {
            if (singleMedia && singleMedia.option) {
                if (singleMedia.query) {
                    mediaList.push(singleMedia);
                }
                else if (!mediaDefault) {
                    // Use the first media default.
                    mediaDefault = singleMedia;
                }
            }
        });
    }

    // For normal option
    if (!baseOption) {
        baseOption = rawOption;
    }

    // Set timelineOpt to baseOption in ec3,
    // which is convenient for merge option.
    if (!baseOption.timeline) {
        baseOption.timeline = timelineOpt;
    }

    // Preprocess.
    each([baseOption].concat(timelineOptions)
        .concat(zrUtil.map(mediaList, function (media) {
            return media.option;
        })),
        function (option) {
            each(optionPreprocessorFuncs, function (preProcess) {
                preProcess(option, isNew);
            });
        }
    );

    return {
        baseOption: baseOption,
        timelineOptions: timelineOptions,
        mediaDefault: mediaDefault,
        mediaList: mediaList
    };
}

/**
 * @see <http://www.w3.org/TR/css3-mediaqueries/#media1>
 * Support: width, height, aspectRatio
 * Can use max or min as prefix.
 */
function applyMediaQuery(query: MediaQuery, ecWidth: number, ecHeight: number): boolean {
    var realMap = {
        width: ecWidth,
        height: ecHeight,
        aspectratio: ecWidth / ecHeight // lowser case for convenientce.
    };

    var applicatable = true;

    zrUtil.each(query, function (value, attr) {
        var matched = attr.match(QUERY_REG);

        if (!matched || !matched[1] || !matched[2]) {
            return;
        }

        var operator = matched[1];
        var realAttr = matched[2].toLowerCase();

        if (!compare(realMap[realAttr as keyof typeof realMap], value, operator)) {
            applicatable = false;
        }
    });

    return applicatable;
}

function compare(real: number, expect: number, operator: string): boolean {
    if (operator === 'min') {
        return real >= expect;
    }
    else if (operator === 'max') {
        return real <= expect;
    }
    else { // Equals
        return real === expect;
    }
}

function indicesEquals(indices1: number[], indices2: number[]): boolean {
    // indices is always order by asc and has only finite number.
    return indices1.join(',') === indices2.join(',');
}

/**
 * Consider case:
 * `chart.setOption(opt1);`
 * Then user do some interaction like dataZoom, dataView changing.
 * `chart.setOption(opt2);`
 * Then user press 'reset button' in toolbox.
 *
 * After doing that all of the interaction effects should be reset, the
 * chart should be the same as the result of invoke
 * `chart.setOption(opt1); chart.setOption(opt2);`.
 *
 * Although it is not able ensure that
 * `chart.setOption(opt1); chart.setOption(opt2);` is equivalents to
 * `chart.setOption(merge(opt1, opt2));` exactly,
 * this might be the only simple way to implement that feature.
 *
 * MEMO: We've considered some other approaches:
 * 1. Each model handle its self restoration but not uniform treatment.
 *     (Too complex in logic and error-prone)
 * 2. Use a shadow ecModel. (Performace expensive)
 */
function mergeOption(oldOption: ECUnitOption, newOption: ECUnitOption): void {
    newOption = newOption || {};

    each(newOption, function (newCptOpt, mainType) {
        if (newCptOpt == null) {
            return;
        }

        var oldCptOpt = oldOption[mainType];

        if (!(ComponentModel as ComponentModelConstructor).hasClass(mainType)) {
            oldOption[mainType] = merge(oldCptOpt, newCptOpt, true);
        }
        else {
            newCptOpt = modelUtil.normalizeToArray(newCptOpt);
            oldCptOpt = modelUtil.normalizeToArray(oldCptOpt);

            var mapResult = modelUtil.mappingToExists(oldCptOpt, newCptOpt);

            oldOption[mainType] = map(mapResult, function (item) {
                return (item.option && item.exist)
                    ? merge(item.exist, item.option, true)
                    : (item.exist || item.option);
            });
        }
    });
}

export default OptionManager;
