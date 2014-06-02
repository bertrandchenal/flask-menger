from collections import defaultdict
from itertools import groupby, product
import logging
import os
from tempfile import mkdtemp

from flask import send_file

import flask_menger as app
from menger import Dimension, Measure


logger = logging.getLogger('menger.flask')


def get_dimension(space, name):
    if not hasattr(space, name):
        raise Exception('Space %s has not attribute %s.' % (space.name, name))
    dim = getattr(space, name)
    if not isinstance(dim, Dimension):
        raise Exception('%s is not a dimension on space  %s.' % (
            space.name, name))

    return dim


def get_measure(space, name):
    if '.' in name:
        _, name = name.split('.')

    if not hasattr(space, name):
        raise Exception('Space %s has not attribute %s.' % (space.name, name))
    msr = getattr(space, name)
    if not isinstance(msr, Measure):
        raise Exception('%s is not a measure on space  %s.' % (
            space.name, name))

    return msr


def dice(dimensions, measures):
    # Get space
    spc_name = measures[0].split('.')[0]
    spc = app.SPACES.get(spc_name)
    if not spc:
        raise Exception('Space %s not found' % spc_name)

    # Search for a pivot
    pivot_name = None
    regular_names = []
    for name, _ in dimensions:
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
        'label': spc._label + ' / ' + get_measure(spc, m).label,
        'type': 'measure',
        'name': get_measure(spc, m).name,
    } for m in measures]

    # No pivot, return regular output
    if not pivot_name:
        dim_cols = [{
            'label': get_dimension(spc, d[0]).label,
            'type': 'dimension',
        } for d in dimensions]

        data_dict = dice_by_msr(dimensions, measures)
        d_drills = [get_dimension(spc, d).glob(v) for d, v in dimensions]
        data = [list(key) + data_dict[key] for key in product(*d_drills)]
        return data, dim_cols + msr_cols

    # split dimensions and get pivot values depth
    depth = None
    pivot_dims = []
    regular_dims = [d for d in dimensions if d[0] in regular_names]
    for d in dimensions:
        name, vals = d
        if name != pivot_name:
            continue
        if depth is None:
            depth = len(vals)
        elif len(vals) != depth:
            # Values len mismatch on pivot dimensions
            continue
        pivot_dims.append(d)

    # Query db for each member of pivot
    datas = []
    for d in pivot_dims:
        data = {}
        datas.append(dice_by_msr(regular_dims + [d], measures))

    r_drills = [get_dimension(spc, d).glob(v) for d, v in regular_dims]
    pivot_heads = [v[:-1] for d, v in pivot_dims]
    pivot_tails = set()
    for d, v in pivot_dims:
        for child in get_dimension(spc, d).glob(v):
            # TODO replace -1 by len(tail) aka number of trailing None
            pivot_tails.add(child[-1:])

    pivot_tails = sorted(pivot_tails)
    merged_data = []

    for base_key in product(*r_drills):
        for tail in pivot_tails:
            # Fill line with regular dimensions + pivot base
            line = list(base_key) + [tail]
            # Extend line for each pivot tails
            for pos, head in enumerate(pivot_heads):
                key = base_key + (head + tail,)
                vals = datas[pos][key]
                if vals is None:
                    continue
                line.extend(vals)

            merged_data.append(line)

    # construct columns metadata
    cols = [{
        'label': get_dimension(spc, d[0]).label,
        'type': 'dimension',
    } for d in regular_dims]

    pivot_dim = get_dimension(spc, pivot_name)
    cols.append({
        'label': pivot_dim.levels[(depth - 1)],
        'type': 'dimension',
    })
    for head in pivot_heads:
        head = '/'.join(str(h) for h in head)
        if head:
            head += ' - '
        cols.extend({
            'label': head + m['label'],
            'type': 'measure',
            'name': m['name'],
        } for m in msr_cols)

    return merged_data, cols


def dice_by_msr(dimensions, measures):
    spc_msr = groupby((m.split('.') for m in measures),
                     lambda x: x[0])

    data = defaultdict(lambda: [0 for _ in measures])
    key_len = len(dimensions)
    for pos, (spc_name, msrs) in enumerate(spc_msr):
        spc = app.SPACES.get(spc_name)
        if not spc:
            raise Exception('space "%s" not found' % spc_name)

        for line in spc.dice(dimensions, (m[1] for m in msrs)):
            key, vals = line[:key_len], line[key_len:]
            for vpos, val in enumerate(vals):
                data[key][pos + vpos] = val
    return data


def build_xlsx(res):
    import openpyxl
    from openpyxl.styles.numbers import NumberFormat
    from openpyxl.styles import Style

    columns = res['columns']
    wb = openpyxl.Workbook(optimized_write=True)
    sheet = wb.create_sheet(title='Results')
    sheet.append([c['label'] for c in columns])
    money_style = Style(number_format=NumberFormat(u"#,##0.00 \u20AC"))

    for line in res['data']:
        line = list(line)
        for pos, col in enumerate(columns):
            if col['type'] == 'dimension':
                line[pos] = '/'.join(str(i) for i in line[pos])
            elif col['type'] == 'measure':
                cell = {'value': line[pos]}
                if col['name'] == 'amount':
                    cell['style'] = money_style
                line[pos] = cell
        sheet.append(line)

    out = os.path.join(mkdtemp(), 'result.xlsx')
    wb.save(out)
    return send_file(out, mimetype="application/vnd.ms-excel")
