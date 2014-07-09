from collections import defaultdict
from itertools import groupby, product, takewhile
import logging
import os
from tempfile import mkdtemp

from flask import send_file

import flask_menger as app
from menger import Dimension, Measure, get_space


logger = logging.getLogger('menger.flask')
not_none = lambda x: x is not None


def get_label(space, name, value):
    value = filter(not_none, value)
    dim = get_dimension(space, name)
    if not value:
        return dim.label
    return "%s: %s" % (dim.label, dim.format(value))


def get_dimension(space, name):
    if not hasattr(space, name):
        raise Exception('Space %s has not attribute %s.' % (space.name, name))
    dim = getattr(space, name)
    if not isinstance(dim, Dimension):
        raise Exception('%s is not a dimension on space  %s.' % (
            space.name, name))
    return dim


def get_head(values):
    """
    Return a tuple of the first non-None items in values list
    """
    return tuple(takewhile(not_none, values))


def get_measure(name):
    space_name, name = name.split('.')
    space = get_space(space_name)
    if not hasattr(space, name):
        raise Exception('Space %s has not attribute %s.' % (space._name, name))
    msr = getattr(space, name)
    if not isinstance(msr, Measure):
        raise Exception('%s is not a measure on space  %s.' % (
            space._name, name))

    return msr


def dice(coordinates, measures, format_type=None):
    # Get space
    spc_name = measures[0].split('.')[0]
    spc = get_space(spc_name)
    if not spc:
        raise Exception('Space %s not found' % spc_name)

    # Search for a pivot
    pivot_name = None
    regular_names = []
    for name, _ in coordinates:
        if name in regular_names:
            if pivot_name and pivot_name != name:
                # Double pivot not supported
                continue
            pivot_name = name
        else:
            regular_names.append(name)

    # clean regular_names
    while pivot_name in regular_names:
        regular_names.remove(pivot_name)

    msr_cols = [{
        'label': spc._label + '/' + get_measure(m).label,
        'type': 'measure',
        'name': get_measure(m).name,
    } for m in measures]

    # No pivot, return regular output
    if not pivot_name:
        dim_cols = [{
            'label': get_label(spc, d[0], d[1]),
            'type': 'dimension',
        } for d in coordinates]

        data_dict = dice_by_msr(coordinates, measures)
        d_drills = [list(get_dimension(spc, d).glob(v)) for d, v in coordinates]
        data = []
        dimensions = [get_dimension(spc, d) for d, v in coordinates]
        measures = [get_measure(m) for m in measures]

        for key in product(*d_drills):
            line = [d.format(v, type=format_type) \
                    for d, v in zip(dimensions, key)]
            line.extend(m.format(v, type=format_type) \
                        for m, v in zip(measures, data_dict[key]))
            data.append(line)
        return data, dim_cols + msr_cols

    pivot_dim = get_dimension(spc, pivot_name)
    # split coordinates and get pivot values depth
    depth = None
    pivot_coords = []
    regular_coords = [d for d in coordinates if d[0] in regular_names]
    for d in coordinates:
        name, vals = d
        if name != pivot_name:
            continue
        if depth is None:
            depth = len(vals)
        elif len(vals) != depth:
            # Values len mismatch on pivot coordinates
            continue
        pivot_coords.append(d)

    # Query db for each member of pivot
    datas = []
    for c in pivot_coords:
        data = {}
        datas.append(dice_by_msr(regular_coords + [c], measures))

    r_drills = [get_dimension(spc, d).glob(v) for d, v in regular_coords]
    pivot_heads = []
    pivot_tails = set()
    for c, v in pivot_coords:
        head = get_head(v)
        pivot_heads.append(head)
        cut = len(head)
        for child in get_dimension(spc, c).glob(v):
            pivot_tails.add(child[cut:])

    pivot_tails = sorted(pivot_tails)
    merged_data = []

    # Prepare dim & measures list for formating
    reg_dims = [get_dimension(spc, c) for c, v in regular_coords]
    measures = [get_measure(m) for m in measures]

    for base_key in product(*r_drills):
        for tail in pivot_tails:
            # Fill line with regular coordinates
            line = [d.format(k, type=format_type) \
                    for d, k in zip(reg_dims, base_key)]

            # Extend line for each pivot tails
            for pos, head in enumerate(pivot_heads):

                # Add dim value in pivot col
                if pos == 0:
                    line.append(
                        pivot_dim.format(head + tail, type=format_type,
                                         offset=len(head))
                    )

                key = base_key + (head + tail,)
                vals = datas[pos][key]
                if vals is None:
                    continue
                # Add measure values
                line.extend(m.format(v, type=format_type) \
                            for m,v in zip(measures, vals))

            # Format line
            merged_data.append(line)

    # Construct columns metadata
    cols = [{
        'label': get_label(spc, d[0], d[1]),
        'type': 'dimension',
    } for d in regular_coords]

    cols.append({
        'label': pivot_dim.levels[depth - 1],
        'type': 'dimension',
    })
    for head in pivot_heads:
        prefix = pivot_dim.format(head, type=format_type)
        if prefix:
            prefix += ' - '
        cols.extend({
            'label': prefix + m['label'],
            'type': 'measure',
            'name': m['name'],
        } for m in msr_cols)

    return merged_data, cols


def dice_by_msr(coordinates, measures):
    # Create one group of measures per space
    spc_msr = groupby((m.split('.') for m in measures),
                     lambda x: x[0])

    data = defaultdict(lambda: [0 for _ in measures])
    key_len = len(coordinates)
    for pos, (spc_name, msrs) in enumerate(spc_msr):
        spc = get_space(spc_name)
        if not spc:
            raise Exception('space "%s" not found' % spc_name)

        filters = get_filters()
        for line in spc.dice(coordinates, (m[1] for m in msrs), filters):
            key, vals = line[:key_len], line[key_len:]
            for vpos, val in enumerate(vals):
                data[key][pos + vpos] = val
    return data


def get_filters():
    # TODO shouldn't be here
    # example: return {'date': (2014, 1, 2)}
    return {}


def build_xlsx(res):
    import openpyxl

    columns = res['columns']
    wb = openpyxl.Workbook(optimized_write=True)
    sheet = wb.create_sheet(title='Results')
    sheet.append([c['label'] for c in columns])

    for line in res['data']:
        sheet.append(line)

    out = os.path.join(mkdtemp(), 'result.xlsx')
    wb.save(out)
    return send_file(out, mimetype="application/vnd.ms-excel")
